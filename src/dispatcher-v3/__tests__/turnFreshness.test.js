import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live LLM prohibited'); } } }));
import { START_TIME, createHarness, finish, until, plan } from './helpers/auditRuntimeHarness.js';
import { runWithV3Life, assertV3Life } from '../turnLifecycle.js';
let harnesses, networkGuard;
const pending = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT','synthetic-model');
  networkGuard=vi.fn(() => { throw new Error('Unexpected external network'); });
  vi.stubGlobal('fetch',networkGuard);
  harnesses=[];
});
afterEach(async () => {
  try {
    for(const h of harnesses) await h.close();
    expect(networkGuard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
  }
});
async function make(options) { const h=await createHarness(options);harnesses.push(h);return h; }
function newest(h) { return [...h.runtime._lifecycle.turns.values()].at(-1); }
function diagnostic(h, phase) { return h.diagnostics.record.mock.calls.map(([value])=>value).filter(x=>x.phase===phase); }

describe('01-05 actual authenticated V3 turn freshness and authorization', () => {
  it('revoked active account cannot turn a late model answer into a CAD mutation', async () => {
    const h=await make();const wait=pending();
    h.llm.mockImplementationOnce(() => wait.promise);
    const principal=await h.principal('A1');
    const capture=await h.capture('A1',{principal});h.frame(capture);
    const turn=h.end(capture,'Central, please change my status to available');
    await until(()=>h.llm.mock.calls.length===1,'pending model');
    h.revokeAccount(principal);
    wait.resolve({choices:[{message:{content:JSON.stringify(plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'}))}}]});
    await finish(turn);
    expect(h.writes()).toEqual([]);
    expect(h.cad.units[0].status).toBe('on_duty');
    expect(h.runtime.executor.execute.mock.results.at(-1)?.value).toBeDefined();
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
  });
  it('removing a channel grant before action blocks that action and preserves center', async () => {
    const h=await make();const wait=pending();h.llm.mockImplementationOnce(()=>wait.promise);
    const principal=await h.principal('A1');
    const capture=await h.capture('A1',{principal});h.frame(capture);
    const turn=h.end(capture,'Central, please change my status to available');
    await until(()=>h.llm.mock.calls.length===1,'model waiting');
    h.revokeChannelGrant(principal);
    wait.resolve({choices:[{message:{content:JSON.stringify(plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'}))}}]});
    await finish(turn);expect(h.writes()).toEqual([]);
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
  });
  it('changing account unit ownership during planning cannot substitute another actor', async () => {
    const h=await make();const wait=pending();h.llm.mockImplementationOnce(()=>wait.promise);
    const principal=await h.principal('A1');
    const capture=await h.capture('A1',{principal});h.frame(capture);
    const turn=h.end(capture,'Central, please change my status to available');
    await until(()=>h.llm.mock.calls.length===1,'model waiting');
    h.changeAccountUnit(principal,'B2');
    wait.resolve({choices:[{message:{content:JSON.stringify(plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'}))}}]});
    await finish(turn);expect(h.writes()).toEqual([]);
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
  });
  it('keeps normal, unchanged actor permissions working', async () => {
    const h=await make();
    expect(await h.send('Central, available','A1')).toBe(true);
    expect(h.writes('/api/radio/status').map(x=>x.body.unit_id)).toEqual(['A1']);
    expect((await h.lastResult()).data.verified).toBe(true);
  });
  it('stopping and restarting while STT is pending prevents old generation writes', async () => {
    const h=await make();const words=h.hold('Central, available');
    const turn=await h.begin(words.promise);
    await until(()=>h.transcribe.mock.calls.length===1,'pending STT');
    const oldGeneration=h.runtime.runtimeGeneration;
    await h.runtime.stop();await h.runtime.start();
    expect(h.runtime.runtimeGeneration).not.toBe(oldGeneration);
    words.resolve('Central, available');await finish(turn);
    expect(h.writes()).toEqual([]);
    await h.send('Central, en route');
    expect(h.writes('/api/radio/status').map(x=>x.body.status)).toEqual(['en_route']);
  });
  it('stopping and restarting during model planning rejects late model output', async () => {
    const h=await make();const wait=pending();h.llm.mockImplementationOnce(()=>wait.promise);
    const turn=await h.begin('Central, please change my status to available');
    await until(()=>h.llm.mock.calls.length===1,'model started');
    await h.runtime.stop();await h.runtime.start();
    wait.resolve({choices:[{message:{content:JSON.stringify(plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'}))}}]});
    await finish(turn);expect(h.writes()).toEqual([]);
    await h.send('Central, on scene');
    expect(h.writes('/api/radio/status').map(x=>x.body.status)).toEqual(['on_scene']);
  });
  it('a still-pending reply is rejected if its original task expires during planning', async () => {
    const h=await make({llmPlans:[{...plan('CLARIFY'),clarification:'Which location?'}]});
    await h.send('Central, clarify the location from earlier');
    const original=h.runtime.conversationGate.pending.get('A1');
    expect(original).toBeTruthy();
    original.expiresAt=Date.now()+10;
    const wait=pending();h.llm.mockImplementationOnce(()=>wait.promise);
    const reply=await h.begin('the west entrance');
    await until(()=>h.llm.mock.calls.length===2,'pending reply model');
    await vi.advanceTimersByTimeAsync(12);
    wait.resolve({choices:[{message:{content:JSON.stringify(plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'}))}}]});
    await finish(reply);
    expect(h.writes()).toEqual([]);
    expect(diagnostic(h,'turn_completed').at(-1).success).toBe(false);
  });
  it('five-minute-old delayed transcription never mutates CAD even after late completion', async () => {
    const h=await make();const words=h.hold('Central, available');
    const turn=await h.begin(words.promise);
    await until(()=>h.transcribe.mock.calls.length===1,'STT started');
    await vi.advanceTimersByTimeAsync(300001);
    words.resolve('Central, available');await finish(turn);
    expect(h.writes()).toEqual([]);
  });
  it('explicitly supersedes only the selected queued command, not an earlier valid command', async () => {
    const h=await make();const words=h.hold('Central, en route');
    const first=await h.begin(words.promise);
    await until(()=>h.transcribe.mock.calls.length===1,'old STT');
    const second=await h.begin('Central, available');
    await until(()=>h.transcribe.mock.calls.length===2,'new STT');
    const target=newest(h);
    const canceled=h.runtime.cancelTurnById(target.identity.turnId);
    expect(canceled).toMatchObject({disposition:'not_submitted',submittedWrites:0});
    words.resolve('Central, en route');
    await finish(first);await finish(second);
    expect(h.writes('/api/radio/status').map(x=>x.body.status)).toEqual(['en_route']);
  });
  it('records a submitted write as requiring reconciliation rather than a rollback promise', async () => {
    const h=await make();const capture=await h.capture('A1');h.frame(capture);
    const state=newest(h);const ticket=state.owner.submitted(state,'POST');
    expect(ticket).toBeTruthy();
    const result=h.runtime.cancelTurnById(state.identity.turnId);
    expect(result).toMatchObject({submittedWrites:1,possibleUnconfirmedWrite:true,disposition:'submitted_reconciliation_required'});
    state.owner.responded(state,ticket);
    expect(await finish(h.end(capture,'Central, available'))).toBe(false);
    expect(h.writes()).toEqual([]);
  });
  it('a canceled generation never regains life merely because the runtime restarted', async () => {
    const h=await make();const capture=await h.capture('A1');h.frame(capture);
    const old=newest(h);
    await h.runtime.stop();await h.runtime.start();
    expect(()=>runWithV3Life(old,()=>assertV3Life())).toThrow();
    expect(await finish(h.end(capture,'Central, available'))).toBe(false);
    expect(h.writes()).toEqual([]);
  });
  it('an expired session rejects an otherwise active account at CAD action time', async () => {
    const h=await make();
    const principal=await h.principal('A1');
    const capture=await h.capture('A1',{principal});h.frame(capture);
    h.expireSession(principal);
    await finish(h.end(capture,'Central, available'));
    expect(h.writes()).toEqual([]);
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
  });
  it('a locked radio token blocks a subsequent CAD mutation without weakening intake', async () => {
    const h=await make();
    const principal=await h.principal('B2',{credentialType:'radio-token',connectionId:'radio-locked-fixture'});
    const capture=await h.capture('B2',{principal,source:'radio'});h.frame(capture);
    h.lockRadio(principal);
    await finish(h.end(capture,'Central, available'));
    expect(h.writes()).toEqual([]);
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
  });

});
