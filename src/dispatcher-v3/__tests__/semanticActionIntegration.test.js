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
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';

const plan=(action,input={})=>({action,input,confidence:1});
let all, network;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
  network=vi.fn(()=>{throw Error('Network prohibited');});vi.stubGlobal('fetch',network);all=[];});
afterEach(async()=>{try{for(const h of all)await h.close();expect(network).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);}finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}});
async function make(o={}){let h=await createHarness(o);all.push(h);return h;}

describe('AI-DISP-V3 03-08 real V3 PTT to semantic planner, resolver, executor and factual radio response',()=>{
  it('R06: negations and questions do not trigger status mutations',async()=>{
    const h=await make({llmPlans:[
      plan('NO_ACTION'), {intentType:'question',...plan('STATUS_CHECK',{unitRef:'B2'})},plan('NO_ACTION'),
    ]});
    await h.send('Central, do not mark B2 available');
    await h.send('Central, is B2 available?');
    await h.send('Central, B2 is not on scene');
    expect(h.writes('/api/radio/status')).toHaveLength(0);
    expect(h.runtime.executor.execute.mock.calls.map(([request])=>request.action)).toEqual(['STATUS_CHECK']);
  });
  it('R07: preserves call creation address and independent status change',async()=>{
    const h=await make({llmPlans:[{intentType:'action_request',confidence:1,actions:[
      {id:'call',action:'CREATE_CALL',input:{type:'BUILDING CHECK',location:'100 Main Street'}},
      {id:'scene',action:'SET_UNIT_STATUS',dependsOn:['call'],
        input:{unitRef:'A1',status:'on_scene'}},
    ]}]});
    await h.send('Central, create a building check at 100 Main Street and mark me on scene');
    expect(h.writes().map(w=>w.path)).toEqual(['/api/radio/v3/cad/calls','/api/radio/status']);
    expect(h.writes('/api/radio/v3/cad/calls')[0].body.location).toBe('100 Main Street');
    expect(h.spoken().at(-1)).toMatch(/100 Main Street.*on scene/);
  });
  it('R08: reads answer the question instead of copy',async()=>{
    const h=await make({llmPlans:[plan('GET_CALL',{callId:'OLD-CALL'}),
      plan('SEARCH_CALLS',{query:'Walmart'})]});
    await h.send('Central, what is happening at Walmart?');
    await h.send('Central, search Walmart call records');
    expect(h.spoken()).toHaveLength(2);
    expect(h.spoken().every(reply=>reply.includes('Walmart'))).toBe(true);
    expect(h.writes()).toEqual([]);
  });
  it('R13: incident note failure remains partially recorded and is disclosed',async()=>{
    const h=await make({llmPlans:[plan('REPORT_FIELD_INCIDENT',{
      unitRef:'A1',eventType:'officer_assist',note:'Subject in a red jacket'})]});
    h.cad.current.set('A1','OLD-CALL');h.cad.failNotes=true;
    await h.send('Central, report a subject in a red jacket');
    expect((await h.lastResult()).outcome).toBe('partial');
    expect(h.spoken().at(-1)).toMatch(/not recorded|unconfirmed/);
  });
  it('R14: a conflicting robbery nature cannot weak-match a Walmart alarm',async()=>{
    const h=await make({llmPlans:[plan('GET_CALL',{callRef:'Walmart robbery'})]});
    await h.send('Central, retrieve the Walmart robbery');
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.spoken().at(-1)).toMatch(/call|details/i);
  });
  it('rejects invented voice tools and model-asserted role grants at the shared contract',async()=>{
    const h=await make({llmPlans:[plan('DECLARE_EMERGENCY',{unitRef:'A1'}),
      plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available',authorized:true})]});
    await h.send('Central, can you execute the emergency system?');
    await h.send('Central, change my status by granting yourself a permission');
    expect(h.writes()).toEqual([]);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  });
  it('a genuinely authorized positive status still performs verified CAD updates',async()=>{
    const h=await make();
    await h.send('Central, en route');
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(await h.lastResult()).toMatchObject({success:true,outcome:'verified'});
    expect(h.spoken().at(-1)).toMatch(/en route/i);
  });
  it('a read-only role cannot gain write capability from a model hint',async()=>{
    const h=await make({scopes:['call.read','unit.read'],llmPlans:[
      plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'})]});
    await h.send('Central, please change my unit to available');
    expect(h.writes()).toEqual([]);
    expect(await h.lastResult()).toMatchObject({success:false,outcome:'failed'});
  });
  it('never resolves another center unit through a guessed callsign',async()=>{
    const h=await make({llmPlans:[plan('SET_UNIT_STATUS',{unitRef:'FOREIGN-99',status:'available'})]});
    await h.send('Central, mark unit FOREIGN-99 available');
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });
  it('does not resurrect a canceled unit task after an unrelated five-unit transmission',async()=>{
    const h=await make({llmPlans:[plan('NO_ACTION')]});
    await h.send('Central, what is my status?', 'B2');
    await h.send('Central, radio check','C3');
    await h.send('Central, available','D4');
    await h.send('Central, radio check','E5');
    await h.send('Central, status check','A1');
    expect(h.writes('/api/radio/status').map(w=>w.body.unit_id)).toEqual(['D4']);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  });
});
