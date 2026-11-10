import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
vi.mock('../../services/audioRelayService.js',()=>({audioRelayService:{}}));
vi.mock('../../services/signalingService.js',()=>({signalingService:{}}));
vi.mock('../../services/azureSpeechService.js',()=>({
 speechToText:()=>{throw Error('Live STT prohibited')},
 textToSpeech:()=>{throw Error('Live TTS prohibited')},
}));
vi.mock('../../services/opusCodec.js',()=>({opusCodec:{}}));
vi.mock('../../services/floorControlService.js',()=>({floorControlService:{},AI_FLOOR_IDENTITY:'AI-Dispatcher'}));
vi.mock('../../services/emergencyPagingService.js',()=>({pageEmergencyUnits:()=>{throw Error('Live paging prohibited')}}));
vi.mock('openai',()=>({AzureOpenAI:class{constructor(){throw Error('Paid model prohibited')}}}));
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';
let opened,network,scenarios=[];
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START_TIME);
 vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
 network=vi.fn(()=>{throw Error('Network prohibited')});vi.stubGlobal('fetch',network);
 opened=[];});
afterEach(async()=>{try{for(const h of opened)await h.close();
 expect(network).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
 finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}});
async function make(opts={}){const h=await createHarness(opts);opened.push(h);return h;}
function record(h,id){
 const traces=h.diagnostics.entries.filter(e=>e.turnId||e.correlationId)
  .slice(-50).map(e=>({turnId:e.turnId,phase:e.phase,
   classification:e.classification,success:e.success}));
 scenarios.push({id,center:h.context.dispatchCenterId,traceCount:traces.length,
  traceIds:[...new Set(traces.map(e=>e.turnId).filter(Boolean))],
  localRelayFrames:h.relay.injectAudio.mock.calls.length,
  cadMutations:h.writes().length,phases:[...new Set(traces.map(e=>e.phase))],
  observedOutcome:'synthetic_boundary_only'});
 const dest=process.env.DISPATCHER_V3_ACCEPTANCE_TRACE;
 if(dest)writeFileSync(dest,JSON.stringify({scenarios},null,2)+'\n');
}
describe('04-08 repeatable synthetic acceptance evidence',()=>{
 it('records five unit PTT interleaving and safe CAD results',async()=>{
  const h=await make({llmPlans:[
   {action:'NO_ACTION',intentType:'conversation_only',conversationAct:'presence',input:{},confidence:1},
   {action:'GET_CALL',intentType:'question',input:{callId:'OLD-CALL'},answerFocus:['location'],confidence:1},
  ]});
  await h.send('Central, radio check','A1');
  await h.send('Central, available','B2');
  await h.send('Central, are you receiving me?','C3');
  await h.send('Central, where is the Walmart alarm?','D4');
  await h.send('Central, radio check','E5');
  expect(h.spoken()).toHaveLength(5);
  expect(h.writes('/api/radio/status')).toHaveLength(1);
  record(h,'five-unit-interleave');
  expect(scenarios[0].traceIds.length).toBeGreaterThan(0);
  expect(scenarios[0].localRelayFrames).toBe(5);
 });
 it('records controlled TTS failure without fake delivery',async()=>{
  const h=await make();
  h.synthesize.mockImplementationOnce(async()=>{throw Error('Synthetic TTS failure')});
  await h.send('Central, radio check','A1');
  expect(h.runtime.getPipelineStatus().lastOutputFailure?.code).toBe('RADIO_REPLY_NOT_DELIVERED');
  expect(h.relay.injectAudio).not.toHaveBeenCalled();
  record(h,'synthesis-failure');
 });
});
