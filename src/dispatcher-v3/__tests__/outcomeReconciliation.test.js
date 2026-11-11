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

const proposal=(action,input)=>({action,input,confidence:1});
let opened, network;
beforeEach(()=>{
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS','central,dispatch,dispatcher');
  network=vi.fn(()=>{throw Error('External network prohibited');});
  vi.stubGlobal('fetch',network);opened=[];
});
afterEach(async()=>{
  try { for(const h of opened)await h.close();expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); }
  finally{vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
async function make(x={}){const h=await createHarness(x);opened.push(h);return h;}
function lostResponse(h,path){
  const orig=h.cad.fetch;
  h.runtime.gateway.fetchImpl=async(url,opts={})=>{
    const response=await orig(url,opts);
    if((opts.method||'GET')==='POST'&&new URL(url).pathname===path) throw Error('Synthetic lost response after write');
    return response;
  };
}

describe('AI-DISP-V3 03-06 receipt, partial and uncertain CAD outcomes',()=>{
  it('reconciles a lost status POST using independent unit readback without repeating the write',async()=>{
    const h=await make();lostResponse(h,'/api/radio/status');
    await h.send('Central, available');
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(await h.lastResult()).toMatchObject({success:true,outcome:'verified'});
    expect(h.cad.units[0].status).toBe('available');
  });
  it('never guesses a created call ID or retries after a lost POST response',async()=>{
    const h=await make({llmPlans:[proposal('CREATE_CALL',{type:'BUILDING CHECK',location:'100 Main Street'})]});
    lostResponse(h,'/api/radio/v3/cad/calls');
    await h.send('Central, start a building check at 100 Main Street');
    expect(h.writes('/api/radio/v3/cad/calls')).toHaveLength(1);
    expect(await h.lastResult()).toMatchObject({success:false,outcome:'unknown',submittedWrites:1});
    expect(h.spoken().at(-1)).toMatch(/unconfirmed|verify|may have/i);
  });
  it('does not requeue an incident note whose submission outcome is unknown',async()=>{
    const h=await make({llmPlans:[proposal('REPORT_FIELD_INCIDENT',{
      unitRef:'A1',eventType:'officer_assist',note:'Subject running north'})]});
    h.cad.current.set('A1','OLD-CALL');lostResponse(h,'/api/radio/note');
    await h.send('Central, subject running north and send assistance');
    const result=await h.lastResult();
    expect(result.outcome).toBe('partial');
    expect(result.data.partialErrors).toEqual(expect.arrayContaining([
      expect.objectContaining({phase:'add_note',outcome:'unknown',retrySafe:false}),
    ]));
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.spoken().at(-1)).toMatch(/unconfirmed|could not confirm/i);
  });
  it('discloses an incident note failure and does not say it was saved',async()=>{
    const h=await make({llmPlans:[proposal('REPORT_FIELD_INCIDENT',{
      unitRef:'A1',eventType:'officer_assist',note:'Subject moving west'})]});
    h.cad.current.set('A1','OLD-CALL');h.cad.failNotes=true;
    await h.send('Central, record subject moving west');
    const result=await h.lastResult();
    expect(result).toMatchObject({success:false,outcome:'partial'});
    expect(result.data.partialErrors.length).toBeGreaterThan(0);
    expect(h.spoken().at(-1)).toMatch(/unconfirmed|not recorded|failed|unable/i);
  });
  it('does not claim verification after an acknowledged status update did not persist',async()=>{
    const h=await make();h.cad.ignoreStatusWrite=true;await h.send('Central, available');
    const result=await h.lastResult();
    expect(result).toMatchObject({success:false,outcome:'unknown'});
    expect(h.spoken().at(-1)).toMatch(/unconfirmed|unable|verify/i);
  });
});
