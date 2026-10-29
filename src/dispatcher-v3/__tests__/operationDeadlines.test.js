import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('No live STT'); },
  textToSpeech: () => { throw new Error('No live TTS'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('No live paging'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('No live model'); } } }));
import { V3IntentPlanner } from '../intentPlanner.js';
import { withV3Stage, createV3TurnBudget, runWithV3Budget } from '../operationDeadline.js';
import { CommandLinkGateway } from '../cadGateway.js';
import { buildV3RuntimeContext } from '../runtimeContract.js';
import { createHarness, START_TIME, until, finish } from './helpers/auditRuntimeHarness.js';
let harnesses;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-model');
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
  harnesses = [];
});
afterEach(async () => {
  try {
    for (const h of harnesses) await h.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});
async function harness(opts) { const h=await createHarness(opts); harnesses.push(h); return h; }
const deferred = () => { let resolve; const promise = new Promise(r=>{resolve=r;}); return {promise,resolve}; };
const context = () => buildV3RuntimeContext({
  runtimeId:'test-deadline',profileId:'profile-a',dispatchCenterId:'center-a',
  channelId:12,roomKey:'OPS__1',identity:'AI:A',
  cadUrl:'https://cad.example.test',cadApiKey:'no-real-key',scopes:['*'],
});
const response = (body) => ({ ok:true,status:200,headers:new Headers(),text:()=>body });
const observe = p => { const o={done:false,value:null,error:null}; o.promise=p.then(v=>{o.done=true;o.value=v;},e=>{o.done=true;o.error=e;}); return o; };
describe('01-04 complete external operation deadlines', () => {
  it('bounds a transport that ignores AbortSignal during CAD response-body consumption', async () => {
    const body=deferred(); let signal;
    const fetchImpl=vi.fn(async (_url, options)=>{signal=options.signal;return response(body.promise);});
    const gw=new CommandLinkGateway(context(),{fetchImpl,timeoutMs:15,maxSafeRetries:1});
    const op=observe(gw.get('/api/radio/calls'));
    await vi.advanceTimersByTimeAsync(20);
    await op.promise;
    expect(op.error).toMatchObject({code:'OPERATION_TIMEOUT'});
    expect(signal.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    body.resolve(JSON.stringify({success:true,calls:[]}));
    await Promise.resolve();
    expect(op.value).toBe(null);
  });
  it('never retries a timed-out mutation or falsely reports an unverified status', async () => {
    const body=deferred(); const fetchImpl=vi.fn(async()=>response(body.promise));
    const gw=new CommandLinkGateway(context(),{fetchImpl,timeoutMs:15,maxSafeRetries:5});
    const op=observe(gw.post('/api/radio/status',{unit_id:'A1',status:'available'}));
    await vi.advanceTimersByTimeAsync(20); await op.promise;
    expect(op.error).toMatchObject({code:'OPERATION_TIMEOUT'});
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    body.resolve(JSON.stringify({success:true})); await Promise.resolve();
    expect(op.value).toBe(null);
  });
  it('bounds a model provider that never resolves and discards late plans', async () => {
    const pending=deferred(); let signal;
    const create=vi.fn((_input,opts)=>{signal=opts.signal;return pending.promise;});
    const planner=new V3IntentPlanner({client:{chat:{completions:{create}}},timeoutMs:20});
    const op=observe(planner.plan({transcript:'Central, please check the suspicious activity',speakerCallsign:'A1',
      runtimeContext:context(),correlationId:'synthetic-plan'}));
    await vi.advanceTimersByTimeAsync(25); await op.promise;
    expect(op.error).toMatchObject({code:'CAD_UNAVAILABLE'});
    expect(signal.aborted).toBe(true);
    pending.resolve({choices:[{message:{content:JSON.stringify({action:'SET_UNIT_STATUS',input:{unitRef:'A1',status:'available'},confidence:1})}}]});
    await Promise.resolve();
    expect(op.value).toBe(null);
  });
  it('bounds an overall turn even where the local stage limit is longer', async () => {
    const budget=createV3TurnBudget({captureEndedAt:Date.now(),durationMs:12});
    const provider=deferred(); let signal;
    try {
      const op=observe(runWithV3Budget(budget,()=>withV3Stage('slow_provider',500,({signal:s})=>{signal=s;return provider.promise;})));
      await vi.advanceTimersByTimeAsync(15); await op.promise;
      expect(op.error).toMatchObject({code:'OPERATION_TIMEOUT'});
      expect(signal.aborted).toBe(true);
      provider.resolve('late'); await Promise.resolve();
      expect(op.value).toBe(null);
    } finally {budget.finish();}
  });
  it('stalled TTS exits without transmitting audio on late completion', async () => {
    const h=await harness();
    const pending=h.hold(Buffer.alloc(640));
    h.synthesisReplies.push(pending.promise);
    const turn=await h.begin('Central, available');
    await until(()=>h.synthesize.mock.calls.length===1,'pending synthesis');
    await vi.advanceTimersByTimeAsync(12050);
    expect(turn.settled).toBe(true);
    const before=h.relay.injectAudio.mock.calls.length;
    pending.resolve(Buffer.alloc(640));
    await finish(turn); await Promise.resolve();
    expect(h.relay.injectAudio.mock.calls.length).toBe(before);
    expect(h.floor.releaseFloor).toHaveBeenCalled();
    expect(h.writes('/api/radio/status')).toHaveLength(1);
  });
  it('late STT after its stage deadline never plans or executes a CAD mutation', async () => {
    const h=await harness();
    const pending=h.hold('Central, available');
    const turn=await h.begin(pending.promise);
    await until(()=>h.transcribe.mock.calls.length===1,'pending STT');
    await vi.advanceTimersByTimeAsync(15050);
    expect(turn.settled).toBe(true);
    pending.resolve('Central, available');
    await finish(turn);await Promise.resolve();
    expect(h.runtime.planner.plan).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });
  it('does not block B2 when A1 model request has stopped responding', async () => {
    const h=await harness();
    const pending=deferred();
    const original=h.runtime.planner.plan.bind(h.runtime.planner);
    let starts=0;
    vi.spyOn(h.runtime.planner,'plan').mockImplementation((args)=>{
      if(args.speakerCallsign==='A1'){starts++;return pending.promise;}
      return original(args);
    });
    const a=await h.begin('Central, please retrieve the incident details I requested','A1');
    await until(()=>starts===1,'A1 model pending');
    await h.send('Central, available','B2');
    expect(h.writes('/api/radio/status').map(r=>r.body.unit_id)).toEqual(['B2']);
    await vi.advanceTimersByTimeAsync(60050);
    expect(a.settled).toBe(true);
    pending.resolve({action:'SET_UNIT_STATUS',input:{unitRef:'A1',status:'available'},confidence:1});
    await finish(a);await Promise.resolve();
    expect(h.writes('/api/radio/status').map(r=>r.body.unit_id)).toEqual(['B2']);
  });
});
