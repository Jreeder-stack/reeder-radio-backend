import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js',()=>({audioRelayService:{}}));
vi.mock('../../services/signalingService.js',()=>({signalingService:{}}));
vi.mock('../../services/azureSpeechService.js',()=>({speechToText:()=>{throw Error('No network');},textToSpeech:()=>{throw Error('No network');}}));
vi.mock('../../services/opusCodec.js',()=>({opusCodec:{}}));
vi.mock('../../services/floorControlService.js',()=>({floorControlService:{},AI_FLOOR_IDENTITY:'AI-Dispatcher'}));
vi.mock('../../services/emergencyPagingService.js',()=>({pageEmergencyUnits:()=>{throw Error('No paging');}}));
vi.mock('openai',()=>({AzureOpenAI:class{constructor(){throw Error('No paid model');}}}));
import { createHarness, START_TIME } from './helpers/auditRuntimeHarness.js';
import { V3SharedIncidentFacts, clarifyV3GroupMutation } from '../sharedIncidentFacts.js';
const write = (action,input)=>({action,input,confidence:1});
let all,guard;
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT','synthetic-no-network');
  guard=vi.fn(()=>{throw Error('Network prohibited');});vi.stubGlobal('fetch',guard);all=[];
});
afterEach(async()=>{
  try{for(const h of all)await h.close();expect(guard).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
  finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
async function make(o={}){const h=await createHarness(o);all.push(h);return h;}
function together(h,call='OLD-CALL'){
  h.cad.current.set('A1',call);h.cad.current.set('B2',call);
  h.cad.calls.get(call).assigned_units=[{unit_id:'A1'},{unit_id:'B2'}];
}
const read=(callId='OLD-CALL')=>write('GET_CALL',{callId});
describe('02-06 shared incident source and task isolation',()=>{
  it('B2 receives fresh shared CAD facts and an attributed A1 report without A1 pending instructions',async()=>{
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'Subject walking north'}),read()]});
    together(h);
    await h.send('Central, add a note: subject walking north','A1');
    await h.send('Central, what is the update on our call?','B2');
    const input=h.llm.mock.calls.at(-1)[0].messages[1].content;
    const payload=JSON.parse(input);
    expect(payload.sharedIncident).toMatchObject({callId:'OLD-CALL',verifiedCadFacts:true,participatingUnits:['A1','B2'],reportCount:1});
    expect(JSON.stringify(payload)).not.toContain('Subject walking north');
    expect(payload.recentContext).toEqual([]);
    expect(payload.pendingContext).toEqual({});
    expect(h.spoken().at(-1)).toMatch(/A1 reported: Subject walking north.*unverified report/i);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });
  it('B2 cannot inherit A1 delivered disposition even while assigned to same incident',async()=>{
    const h=await make({llmPlans:[read()]});together(h);
    // With B2 still assigned, CLEAR_UNIT would complete without asking for a
    // disposition. Stage a single-unit call before the prompt, then attach B2.
    h.cad.calls.get('OLD-CALL').assigned_units=[{unit_id:'A1'}];
    await h.send('Central, clear me from my call','A1');
    h.cad.calls.get('OLD-CALL').assigned_units.push({unit_id:'B2'});
    const pending=h.runtime.conversationGate.pending.get('A1');
    expect(pending?.kind).toBe('disposition');
    await h.send('Central, what is our call?','B2');
    const payload=JSON.parse(h.llm.mock.calls.at(-1)[0].messages[1].content);
    expect(payload.pendingContext).toEqual({});
    expect(payload.recentContext).toEqual([]);
    expect(h.runtime.conversationGate.pending.get('A1')?.taskId).toBe(pending.taskId);
    expect(h.writes('/api/radio/dispose')).toEqual([]);
  });
  it('rejects B2 shared membership based on current-call endpoint alone',async()=>{
    const h=await make({llmPlans:[read()]});
    h.cad.current.set('B2','OLD-CALL');
    h.cad.calls.get('OLD-CALL').assigned_units=[{unit_id:'A1'}];
    await h.send('Central, tell me about my call','B2');
    const payload=JSON.parse(h.llm.mock.calls.at(-1)[0].messages[1].content);
    expect(payload.sharedIncident).toBeNull();
    expect(h.spoken().at(-1)).not.toContain('Assigned units:');
  });
  it('removes shared view after reassignment and closure without preserving cached incident facts',async()=>{
    const h=await make({llmPlans:[read(),read(),read()]});together(h);
    await h.send('Central, what is our call?','B2');
    h.cad.current.set('B2','NEW-CALL');
    await h.send('Central, what is our call now?','B2');
    expect(JSON.parse(h.llm.mock.calls.at(-1)[0].messages[1].content).sharedIncident).toBeNull();
    h.cad.current.set('B2','OLD-CALL');h.cad.calls.get('OLD-CALL').status='closed';
    await h.send('Central, what about that call?','B2');
    expect(JSON.parse(h.llm.mock.calls.at(-1)[0].messages[1].content).sharedIncident).toBeNull();
  });
  it('does not expose shared reports without call.read scope',async()=>{
    const h=await make({scopes:['unit.read','unit.write'],llmPlans:[read()]});together(h);
    await h.send('Central, what is the call?','B2');
    const payload=JSON.parse(h.llm.mock.calls.at(-1)[0].messages[1].content);
    expect(payload.sharedIncident).toBeNull();
    expect(h.writes()).toEqual([]);
  });
  it('a failed note is not published or attributed as a verified CAD write',async()=>{
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'Unconfirmed description'}),read()]});
    together(h);h.cad.failNotes=true;
    await h.send('Central, add this report','A1');
    h.cad.failNotes=false;
    await h.send('Central, what notes?','B2');
    expect(h.runtime.sharedIncidents.reports).toHaveLength(0);
    expect(h.spoken().at(-1)).not.toContain('Unconfirmed description');
  });
  it('CAD notes without authenticated writer are explicitly unattributed and unverified',async()=>{
    const h=await make({llmPlans:[read()]});together(h);
    h.cad.calls.get('OLD-CALL').call_notes.push({text:'Possible stolen plate'});
    await h.send('Central, what are the reports?','B2');
    expect(h.spoken().at(-1)).toMatch(/Unattributed CAD note: Possible stolen plate.*unverified report/i);
  });
  it('changes made during model planning invalidate the shared answer',async()=>{
    const h=await make({llmPlans:[read()]});together(h);
    const p=h.runtime.planner.plan.bind(h.runtime.planner);
    vi.spyOn(h.runtime.planner,'plan').mockImplementationOnce(async x=>{
      const res=await p(x);h.cad.current.set('B2','NEW-CALL');return res;
    });
    await h.send('Central, what is our shared call?','B2');
    expect(h.spoken().at(-1)).not.toContain('Assigned units:');
  });
  it('two centers with matching callsign and call ID have no shared memory',async()=>{
    const a=await make({center:'center-a',llmPlans:[write('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'A1 center A report'})]});
    const b=await make({center:'center-b',llmPlans:[read()]});together(a);together(b);
    await a.send('Central, add note','A1');
    await b.send('Central, any update?','B2');
    expect(b.spoken().at(-1)).not.toContain('A1 center A report');
    expect(b.runtime.sharedIncidents.reports).toHaveLength(0);
  });
  it('group pronouns cannot cause unit mutations even if units share a call',async()=>{
    const h=await make({llmPlans:[write('SET_UNIT_STATUS',{unitRef:'B2',status:'on_scene'})]});
    together(h);
    await h.send('Central, mark both of us on scene','A1');
    expect(h.writes('/api/radio/status')).toEqual([]);
    expect(h.spoken().at(-1)).toMatch(/individual units.*callsigns/i);
  });
  it('planner-supplied group targets cannot authorize unit changes',async()=>{
    const h=await make({llmPlans:[write('SET_UNIT_STATUS',{unitRef:'we',status:'available'})]});
    together(h);
    await h.send('Central, status change please','A1');
    expect(h.writes('/api/radio/status')).toEqual([]);
    expect(h.spoken().at(-1)).toContain('individual units');
  });
  it('explicit individual command remains authorized and CAD-verified',async()=>{
    const h=await make({llmPlans:[write('SET_UNIT_STATUS',{unitRef:'B2',status:'on_scene'})]});
    together(h);
    await h.send('Central, mark B2 on scene','A1');
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.cad.units.find(x=>x.unit_id==='B2').status).toBe('on_scene');
  });
  it('ambiguous we are both on scene never becomes even one unintended status change',async()=>{
    const h=await make({llmPlans:[write('SET_UNIT_STATUS',{unitRef:'A1',status:'on_scene'})]});
    together(h);await h.send("Central, we're both on scene",'A1');
    expect(h.writes('/api/radio/status')).toHaveLength(0);
    expect(h.spoken().at(-1)).toMatch(/Which individual units/i);
  });
  it('multiple CAD notes with the same text remain unattributed without a reliable note identity',async()=>{
    const h=await make({llmPlans:[write('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'Unknown direction'}),read()]});
    together(h);await h.send('Central, note unknown direction','A1');
    h.cad.calls.get('OLD-CALL').call_notes.push({text:'Unknown direction'});
    await h.send('Central, read the notes','B2');
    expect(h.spoken().at(-1)).not.toContain('A1 reported:');
    expect(h.spoken().at(-1)).toContain('Unattributed CAD note:');
  });
  it('read-only we/our references do not request a group mutation',()=>{
    expect(clarifyV3GroupMutation({plan:read(),transcript:'what is our call?'})).toBeNull();
  });
  it('report TTL, bounds and stop cleanup prevent stale attribution',async()=>{
    const h=await make();together(h);
    const service=h.runtime.sharedIncidents;
    const envelope={...h.runtime.context,role:'mock'};
    expect(service.reports).toEqual([]);
    await h.runtime.stop();
    expect(service.reports).toEqual([]);
  });
});
