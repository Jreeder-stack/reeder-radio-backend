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
import { composeV3FailureReply, v3OperatorFault } from '../operationalReplies.js';
import { composeV3Response } from '../responseComposer.js';
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';
let opened,network;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START_TIME);
 vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
 network=vi.fn(()=>{throw Error('Network prohibited')});vi.stubGlobal('fetch',network);opened=[]});
afterEach(async()=>{try{for(const h of opened)await h.close();
 expect(network).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
 finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}});
async function make(o={}){const h=await createHarness(o);opened.push(h);return h;}
const reply=(code,extras={})=>composeV3Response({plan:{action:'SET_UNIT_STATUS'},
 result:{success:false,error:{code,message:'secret internal CAD details'},...extras},speakerCallsign:'B2'});
describe('04-04 truthful operational errors and delivery status',()=>{
 it.each([
  ['CAD_UNAVAILABLE',/CAD is not available/],
  ['UNAUTHORIZED',/isn't authorized/],
  ['TURN_STALE',/expired/],
  ['ZONE_NOT_FOUND',/zone is not available/],
  ['INVALID_STATUS_TRANSITION',/rejected that status change/],
  ['INVALID_ACTION',/not supported/],
  ['INVALID_ACTION_INPUT',/required detail/],
  ['INTERNAL_ERROR',/could not process/],
 ])('speaks %s as a precise bounded category', (code,rx)=>{
  const text=reply(code);expect(text).toMatch(rx);expect(text).not.toContain('secret');
 });
 it('never claims a submitted but unverified operation failed safely to retry',()=>{
  expect(composeV3FailureReply({speakerCallsign:'A1',error:{code:'CAD_UNAVAILABLE'},
   submittedWrites:1})).toMatch(/Do not repeat/);
  expect(reply('CAD_UNAVAILABLE',{outcome:'unknown',submittedWrites:1})).toMatch(/Do not repeat/);
 });
 it('a rejected action does not offer a fake capability or promise handoff',()=>{
  expect(reply('UNAUTHORIZED')).toMatch(/isn't authorized/);
  expect(composeV3FailureReply({speakerCallsign:'B2',error:{code:'UNAUTHORIZED'}}))
    .toMatch(/Contact a human dispatcher/);
  expect(reply('UNAUTHORIZED')).not.toMatch(/sent|notified|transferred|saved/i);
 });
 it('exposes only a safe operator fault when output was not delivered',()=>{
  expect(v3OperatorFault({status:'failed',reason:'secret password',turnId:'t1'}))
   .toMatchObject({code:'RADIO_REPLY_NOT_DELIVERED',reason:'radio_delivery_failed',
      turnId:'t1',verifiedHumanAudible:false});
  expect(v3OperatorFault({status:'completed'})).toBeNull();
 });
 it('the actual V3 output lane records an undelivered response without new CAD work',async()=>{
  const h=await make({llmPlans:[{action:'NO_ACTION',intentType:'conversation_only',
    conversationAct:'presence',input:{},confidence:1}]});
  h.synthesize.mockImplementationOnce(async()=>{throw Error('Synthetic TTS failed')});
  await h.send('Central, are you there?');
  expect(h.writes()).toEqual([]);
  expect(h.runtime.getPipelineStatus().lastOutputFailure).toMatchObject({
    code:'RADIO_REPLY_NOT_DELIVERED',verifiedHumanAudible:false});
  expect(h.runtime.conversationGate.pendingFor('A1')).toBeUndefined();
 });
});
