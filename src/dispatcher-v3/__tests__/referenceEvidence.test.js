import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw Error('Live STT prohibited'); },
  textToSpeech: () => { throw Error('Live TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({
  floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher',
}));
vi.mock('../../services/emergencyPagingService.js', () => ({
  pageEmergencyUnits: () => { throw Error('Live paging prohibited'); },
}));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw Error('Live model prohibited'); } } }));
import { V3OperationalContextService } from '../operationalContext.js';
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';

const read = (action, input) => ({ intentType: 'question', action, input, confidence: 1 });
const write = (action, input) => ({ intentType: 'action_request', action, input, confidence: 1 });
let opened, network;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
  network = vi.fn(() => { throw Error('Network prohibited'); }); vi.stubGlobal('fetch',network); opened=[];
});
afterEach(async () => {
  try { for (const h of opened) await h.close(); expect(network).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); }
  finally { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
});
async function make(opts={}) { const h=await createHarness(opts);opened.push(h);return h; }

describe('AI-DISP-V3 03-04 authoritative unit and call selection', () => {
  it('never maps Walmart robbery to the sole Walmart alarm', async () => {
    const h=await make({llmPlans:[read('GET_CALL',{callRef:'Walmart robbery'})]});
    await h.send('Central, retrieve the Walmart robbery details');
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
    expect(h.spoken().at(-1)).toMatch(/active call|couldn.t locate|no.*call/i);
  });
  it('resolves exact nature and location, without partial-string matches', async () => {
    const h=await make({llmPlans:[read('GET_CALL',{callRef:'Walmart alarm'})]});
    await h.send('Central, tell me about the Walmart alarm');
    const result=await h.lastResult();
    expect(result).toMatchObject({success:true,action:'GET_CALL'});
    expect(result.data.call.type).toBe('ALARM');
    expect(result.data.call.location).toBe('Walmart');
  });
  it('returns ambiguity for duplicate calls and will not guess a target', async () => {
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callRef:'Walmart alarm',note:'Caller waiting'})]});
    h.cad.calls.set('DUPLICATE-ALARM',{...structuredClone(h.cad.calls.get('OLD-CALL')),
      call_id:'DUPLICATE-ALARM',id:'DUPLICATE-ALARM',call_number:'DUPLICATE-ALARM'});
    await h.send('Central, note the caller waiting on the Walmart alarm');
    expect(h.writes('/api/radio/note')).toHaveLength(0);
    expect(h.spoken().at(-1)).toMatch(/which call|more than one/i);
  });
  it('does not use substring matching for call nature or location', async () => {
    const h=await make({llmPlans:[read('GET_CALL',{callRef:'mart'})]});
    await h.send('Central, find the mart call');
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });
  it('preserves explicit authorized older-call writes without redirection to current call', async () => {
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'Supplemental witness statement'})]});
    h.cad.current.set('A1','NEW-CALL');
    await h.send('Central, add a supplemental witness statement to OLD-CALL');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.cad.calls.get('OLD-CALL').call_notes).toHaveLength(1);
    expect(h.cad.calls.get('NEW-CALL').call_notes).toHaveLength(0);
  });
  it('revalidates the call immediately before an authorized write', async () => {
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callRef:'Walmart alarm',note:'Caller waiting'})]});
    const original=h.runtime.operationalContextService.resolveCallId.bind(h.runtime.operationalContextService);
    vi.spyOn(h.runtime.operationalContextService,'resolveCallId').mockImplementation(async args=>{
      const id=await original(args); h.cad.calls.get('OLD-CALL').status='closed'; return id;
    });
    await h.send('Central, note caller waiting on the Walmart alarm');
    expect(h.writes('/api/radio/note')).toHaveLength(0);
  });
  it('rejects explicitly supplied call IDs from another center', async () => {
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'Cross center'})]});
    h.cad.calls.get('OLD-CALL').dispatch_center_id='center-b';
    await h.send('Central, note the old call');
    expect(h.writes('/api/radio/note')).toHaveLength(0);
    expect(h.spoken().at(-1)).toMatch(/not authorized|unable|which call/i);
  });
  it('a reassigned unit identity cannot be used after resolution at the write boundary', async () => {
    const h=await make({llmPlans:[write('SET_UNIT_STATUS',{unitRef:'B2',status:'on_scene'})]});
    const original=h.runtime.unitIdentityService.resolve.bind(h.runtime.unitIdentityService);
    let times=0;
    vi.spyOn(h.runtime.unitIdentityService,'resolve').mockImplementation(async (ref,args)=>{
      const result=await original(ref,args);
      if(String(ref)==='B2' && ++times===1) h.cad.units.find(u=>u.unit_number==='B2').id='changed-B2';
      return result;
    });
    await h.send('Central, show B2 on scene');
    expect(h.writes('/api/radio/status')).toHaveLength(0);
  });
});
