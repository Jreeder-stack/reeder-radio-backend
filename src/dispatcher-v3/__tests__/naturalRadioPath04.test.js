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
vi.mock('openai',()=>({AzureOpenAI:class{constructor(){throw Error('Paid model prohibited')}}}));
import { createHarness, START_TIME, finish } from './helpers/auditRuntimeHarness.js';
let opened,network;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START_TIME);
 vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
 network=vi.fn(()=>{throw Error('Network prohibited')});vi.stubGlobal('fetch',network);opened=[];});
afterEach(async()=>{try{for(const h of opened)await h.close();
 expect(network).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
 finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}});
const convo=act=>({action:'NO_ACTION',intentType:'conversation_only',input:{},conversationAct:act,confidence:1});
async function make(o={}){const h=await createHarness(o);opened.push(h);return h;}
describe('04-07 actual V3 authenticated PTT-to-response path',()=>{
 it('shares one runtime, radio output lane and correlated diagnostics for conversation, CAD read and verified write',async()=>{
  const h=await make({llmPlans:[convo('presence'),{
   action:'GET_CALL',intentType:'question',answerFocus:['location'],
   input:{callId:'OLD-CALL'},confidence:1,
  }]});
  await h.send('Central, are you receiving me?','A1');
  await h.send('Central, where is the Walmart alarm?','B2');
  await h.send('Central, available','C3');
  expect(h.spoken()).toHaveLength(3);
  expect(h.spoken()[0]).toMatch(/^A1, Central here/);
  expect(h.spoken()[1]).toMatch(/^B2, call .*Walmart/);
  expect(h.spoken()[2]).toMatch(/^C3,.*available/);
  expect(h.writes('/api/radio/status')).toHaveLength(1);
  expect(h.relay.injectAudio).toHaveBeenCalledTimes(3);
  expect(h.floor.releaseFloor).toHaveBeenCalledTimes(3);
  const composed=h.diagnostics.entries.filter(entry=>entry.phase==='response_composed');
  expect(composed.length).toBeGreaterThanOrEqual(3);
  expect(composed.every(entry=>!entry.details?.transcript)).toBe(true);
 });
 it('keeps unaddressed same-channel traffic silent while unrelated units advance',async()=>{
  const h=await make({llmPlans:[convo('presence')]});
  expect(await h.send('B2, transmit your notes now','A1')).toBe(false);
  await h.send('Central, still monitoring?','E5');
  expect(h.spoken()).toEqual(['E5, Central here. Go ahead.']);
  expect(h.writes()).toEqual([]);
 });
 it('separates identically named units across different dispatch centers',async()=>{
  const a=await make({center:'center-a',llmPlans:[convo('identity')]});
  const b=await make({center:'center-b',llmPlans:[convo('presence')]});
  await a.send('Central, who is this?','A1');
  await b.send('Central, are you there?','A1');
  expect(a.spoken()).toEqual(['A1, This is the automated dispatcher. Go ahead.']);
  expect(b.spoken()).toEqual(['A1, Central here. Go ahead.']);
  expect(a.writes()).toEqual([]);expect(b.writes()).toEqual([]);
 });
 it('does not change emergency hardware state for an ordinary conversation',async()=>{
  const h=await make({llmPlans:[convo('standby')]});
  await h.send('Central, I will send more information','D4');
  expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  expect(h.spoken()[0]).toMatch(/Standing by/);
 });
 it('routes uncertain CAD writes through the same audible outcome lane, never false success',async()=>{
  const h=await make();h.cad.failStatus=true;
  await h.send('Central, available','A1');
  expect(h.spoken().at(-1)).toMatch(/unconfirmed|Do not repeat/i);
  expect(h.runtime.operatorHandoffSnapshot().requiresReview).toBe(true);
  expect(h.relay.injectAudio).toHaveBeenCalledTimes(1);
 });
 it('keeps client PTT start/end methods and captured identity intact',async()=>{
  const h=await make();
  const capture=await h.capture('B2');
  expect(capture.accepted).toBe(true);
  h.frame(capture);
  const finished=h.end(capture,'Central, radio check');
  expect(await finish(finished)).toBe(true);
  await h.flushOutput();
  expect(h.spoken().at(-1)).toMatch(/^B2, loud and clear/);
 });
});
