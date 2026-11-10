import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js',()=>({audioRelayService:{}}));
vi.mock('../../services/signalingService.js',()=>({signalingService:{}}));
vi.mock('../../services/azureSpeechService.js',()=>({
 speechToText:()=>{throw Error('Live STT prohibited')},
 textToSpeech:()=>{throw Error('Live TTS prohibited')},
}));
vi.mock('../../services/opusCodec.js',()=>({opusCodec:{}}));
vi.mock('../../services/floorControlService.js',()=>({floorControlService:{},AI_FLOOR_IDENTITY:'AI-Dispatcher'}));
vi.mock('../../services/emergencyPagingService.js',()=>({pageEmergencyUnits:()=>{throw Error('Live paging prohibited')}}));
vi.mock('openai',()=>({AzureOpenAI:class {constructor(){throw Error('Paid model prohibited')}}}));
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';
import { clarificationQuestion, clarificationTerminal, V3_MAX_CLARIFICATION_PROMPTS } from '../clarificationPolicy.js';
let opened,network;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START_TIME);
 vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
 network=vi.fn(()=>{throw Error('Network prohibited')});vi.stubGlobal('fetch',network);opened=[];});
afterEach(async()=>{try{for(const h of opened)await h.close();
 expect(network).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
 finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}});
async function make(opts={}){const h=await createHarness(opts);opened.push(h);return h;}
const pending=(field='location')=>({action:'CREATE_CALL',input:{type:'BUILDING CHECK'},
 unresolvedField:field,candidateIds:[]});
const propose=()=>({action:'CLARIFY',intentType:'clarification',input:{},confidence:1,
 clarification:'Repeat your request.',pendingTask:pending()});
const clarify=()=>({action:'CLARIFY',intentType:'clarification',input:{},confidence:1,
 clarification:'Which one?'});
describe('04-03 finite, task-owned recovery',()=>{
 it('asks only the missing field and never treats hesitation as a CAD value',()=>{
  expect(clarificationQuestion(pending(),'Repeat your request.','A1','uh')).toMatch(/exact location/);
  expect(clarificationQuestion(pending('unitRef'),'Which one?','B2')).toMatch(/complete callsign/);
  expect(clarificationTerminal(pending('callId'),'A1',0)).toMatch(/cannot confirm the call/);
  expect(V3_MAX_CLARIFICATION_PROMPTS).toBe(3);
 });
 it('preserves original call type through a short reply using the real PTT path',async()=>{
  const h=await make({llmPlans:[propose(),{
   action:'CREATE_CALL',intentType:'action_request',input:{location:'100 Main Street'},confidence:1,
  }]});
  await h.send('Central, open a building check');expect(h.spoken().at(-1)).toMatch(/exact location/);
  await h.send('100 Main Street');
  expect(h.writes('/api/radio/v3/cad/calls')).toHaveLength(1);
  expect(h.writes('/api/radio/v3/cad/calls')[0].body).toMatchObject({type:'BUILDING CHECK',location:'100 Main Street'});
  expect(h.spoken().at(-1)).toMatch(/created/i);
 });
 it('bounds repeated unclear answers and retires only the owned task',async()=>{
  const h=await make({llmPlans:[propose(),clarify(),clarify(),clarify()]});
  await h.send('Central, open a building check');
  await h.send('uh');await h.send('not sure');
  expect(h.spoken().at(-1)).toMatch(/exact location/);
  await h.send('let me check');
  expect(h.spoken().at(-1)).toMatch(/contact a human dispatcher/);
  expect(h.spoken().at(-1)).toMatch(/No new CAD change was confirmed/);
  expect(h.runtime.conversationGate.pendingFor('A1')).toBeUndefined();
  expect(h.writes()).toEqual([]);
 });
 it('does not move a retained task into a new independently addressed request',async()=>{
  const h=await make({llmPlans:[propose()]});
  await h.send('Central, open a building check');
  await h.send('Central, radio check');
  expect(h.writes()).toEqual([]);
  expect(h.spoken().at(-1)).toMatch(/loud and clear/);
 });
 it('keeps another unit independent of the first unit’s missing detail',async()=>{
  const h=await make({llmPlans:[propose()]});
  await h.send('Central, open a building check','A1');
  await h.send('Central, radio check','B2');
  expect(h.spoken().at(-1)).toMatch(/^B2, loud and clear/);
  expect(h.writes()).toEqual([]);
 });
 it('does not allow an unrelated call ID to replace the retained target',async()=>{
  const h=await make({llmPlans:[{action:'CLARIFY',intentType:'clarification',input:{},
    clarification:'Which call?',pendingTask:{action:'ADD_CALL_NOTE',
    input:{note:'Witness departed'},unresolvedField:'callId',candidateIds:['OLD-CALL']},confidence:1},
    {action:'ADD_CALL_NOTE',intentType:'action_request',input:{callId:'NEW-CALL'},confidence:1}]});
  await h.send('Central, add witness departed to that call');
  await h.send('the other call');
  expect(h.writes('/api/radio/note')).toHaveLength(0);
  expect(h.spoken().at(-1)).toMatch(/Which call|call number/i);
 });
});
