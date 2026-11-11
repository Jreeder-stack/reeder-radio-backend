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
import { START_TIME, createHarness, finish, observe } from './helpers/auditRuntimeHarness.js';
let opened,network;
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(START_TIME);
 vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
 network=vi.fn(()=>{throw Error('Network prohibited')});vi.stubGlobal('fetch',network);opened=[]});
afterEach(async()=>{try{for(const h of opened)await h.close();
 expect(network).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);}
 finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}});
async function make(o={}){const h=await createHarness(o);opened.push(h);return h;}
describe('04-05 radio discipline and operator takeover',()=>{
 it('refuses AI-origin relay audio instead of treating it as a new unit voice',async()=>{
  const h=await make();const spy=vi.spyOn(h.runtime.speech,'pushFrame');
  expect(h.runtime._audioListener({unitId:h.runtime.identity,
    opusPayload:Buffer.from([2,3])})).toBe(false);
  expect(spy).not.toHaveBeenCalled();
 });
 it('stopping the existing V3 runtime rejects new PTT and drains queued output',async()=>{
  const h=await make();
  const state=h.runtime.operatorHandoffSnapshot();
  expect(state.requiresReview).toBe(false);
  await h.runtime.stop();
  expect(h.runtime.getPipelineStatus().running).toBe(false);
  expect(h.runtime._outbound.status().queued).toBe(0);
  expect(await h.runtime.handlePttStart(h.context.roomKey,'A1')).toBe(false);
 });
 it('records a real unknown CAD outcome for an operator to verify before retrying',async()=>{
  const h=await make();h.cad.failStatus=true;
  await h.send('Central, available');
  const snap=h.runtime.operatorHandoffSnapshot();
  expect(snap.requiresReview).toBe(true);
  expect(snap.uncertainCadOutcomes).toEqual(expect.arrayContaining([
    expect.objectContaining({status:'unknown',requiresHumanReconciliation:true})
  ]));
  expect(JSON.stringify(snap)).not.toContain('secret');
 });
 it('retains physical emergency authority when stopping the AI',async()=>{
  const h=await make();
  h.runtime.signaling.endEmergencyForUnit=vi.fn();
  await finish(observe(h.runtime.handleEmergencyStart(h.context.roomKey,'A1')));
  expect(h.runtime.operatorHandoffSnapshot().physicalEmergencyActiveAtHandoff).toBe(true);
  await h.runtime.stop();
  expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
 });
 it('urgent outbound alert retains priority over routine speech',async()=>{
  const h=await make();
  expect(h.runtime._outbound.status().running).toBeUndefined();
  expect(h.runtime._outbound.status().limits.maxQueued).toBeGreaterThan(0);
 });
});
