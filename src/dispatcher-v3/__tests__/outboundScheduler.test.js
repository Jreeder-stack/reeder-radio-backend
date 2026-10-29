import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Real STT disabled'); },
  textToSpeech: () => { throw new Error('Real TTS disabled'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Real paging disabled'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Real models disabled'); } } }));
import { V3OutboundScheduler } from '../outboundScheduler.js';
import { createHarness, finish, until, START_TIME } from './helpers/auditRuntimeHarness.js';

let harnesses, networkGuard;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT','synthetic-no-network');
  networkGuard = vi.fn(() => { throw new Error('Unexpected network request'); });
  vi.stubGlobal('fetch', networkGuard); harnesses = [];
});
afterEach(async () => {
  try {
    for (const h of harnesses) await h.close();
    expect(networkGuard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});
async function make() { const h = await createHarness(); harnesses.push(h); return h; }
const config = { channel:'center-a__OPS1', generation:'gen-1' };
function queue(s, { recipient='A1', text='Central, copy', priority=false, kind='routine', generation='gen-1', channel='center-a__OPS1', turnId=null } = {}) {
  return s.enqueue({text,recipient,priority,kind,generation,channel,turnId});
}
function scheduler({transmit=async()=>true,relevant=()=>true,limits={},onOutcome=()=>{}}={}) {
  const s=new V3OutboundScheduler({transmit,relevant,limits,onOutcome});
  s.start('gen-1');return s;
}
describe('01-06 outbound lane and actual V3 integration', () => {
  it('does not keep a first unit CAD turn blocked by stalled speech synthesis', async () => {
    const h=await make();
    const synthesis=h.hold(Buffer.alloc(640));
    h.synthesisReplies.push(synthesis.promise);
    const first=await h.begin('Central, en route');
    await until(()=>h.synthesize.mock.calls.length===1,'first speech queued');
    expect(first.settled).toBe(true);
    expect(h.writes('/api/radio/status').map(x=>x.body.status)).toEqual(['en_route']);
    const second=await h.begin('Central, available');
    await finish(second);
    expect(h.writes('/api/radio/status').map(x=>x.body.status)).toEqual(['en_route','available']);
    synthesis.resolve(Buffer.alloc(640));
    await h.flushOutput();
    expect(h.runtime.getPipelineStatus().outbound.queued).toBe(0);
  });
  it('does not treat an interrupted prompt as completed transmission', async () => {
    const h=await make();
    const tts=h.hold(Buffer.alloc(640));
    h.synthesisReplies.push(tts.promise);
    const turn=await h.begin('Central, en route');
    await until(()=>h.synthesize.mock.calls.length===1,'blocked TTS');
    const envelope=h.transcribe.mock.calls[0][1].turnEnvelope;
    expect(h.runtime._outbound.cancelByTurn(envelope.turnId,'superseded')).toBe(1);
    await h.flushOutput();
    expect(h.runtime.getPipelineStatus().outbound.totals.interrupted).toBeGreaterThan(0);
    expect(h.relay.injectAudio).not.toHaveBeenCalled();
    tts.resolve(Buffer.alloc(640));await finish(turn);
    expect(h.relay.injectAudio).not.toHaveBeenCalled();
  });
  it('an urgent queued alert takes priority over existing routine speech', async () => {
    const hold=deferred();const outcomes=[];let began=[];
    const s=scheduler({transmit:async (entry,check)=>{
      began.push(entry.kind+':'+entry.recipient);
      if(entry.recipient==='A1') {
        await Promise.race([hold.promise,new Promise(resolve=>entry.controller.signal.addEventListener('abort',resolve,{once:true}))]);
        check();
      }
      return true;
    },onOutcome:x=>outcomes.push(x)});
    const first=queue(s,{recipient:'A1'}), second=queue(s,{recipient:'B2'});
    const alert=queue(s,{recipient:'C3',kind:'alert',priority:true,text:'Officer emergency alert'});
    expect((await alert.delivery).status).toBe('completed');
    expect((await first.delivery).status).toBe('interrupted');
    expect((await second.delivery).status).toBe('completed');
    expect(began).toEqual(['routine:A1','alert:C3','routine:B2']);
    expect(outcomes.filter(x=>x.status==='completed')).toHaveLength(2);
    s.stop();
  });
  it('the newest routine reply can replace an older queued response for the same unit', async () => {
    const gate=deferred(), delivered=[];
    const s=scheduler({transmit:async entry=>{
      if(entry.recipient==='B2') await gate.promise;
      delivered.push(entry.text);return true;
    }});
    const blocking=queue(s,{recipient:'B2'});
    const older=queue(s,{recipient:'A1',text:'obsolete request clarification'});
    const fresh=queue(s,{recipient:'A1',text:'current disposition'});
    expect((await older.delivery).status).toBe('expired');
    gate.resolve();
    expect((await blocking.delivery).status).toBe('completed');
    expect((await fresh.delivery).status).toBe('completed');
    expect(delivered).not.toContain('obsolete request clarification');
    s.stop();
  });
  it('an expired queued answer is rejected before taking the floor', async () => {
    const gate=deferred(), delivered=[];
    const s=scheduler({limits:{maxAgeMs:10},transmit:async entry=>{
      if(entry.recipient==='A1') await gate.promise;
      delivered.push(entry.recipient);return true;
    }});
    const first=queue(s,{recipient:'A1'}), queued=queue(s,{recipient:'B2'});
    await vi.advanceTimersByTimeAsync(11);
    gate.resolve();
    await first.delivery;
    expect((await queued.delivery).status).toBe('expired');
    expect(delivered).toEqual(['A1']);
    s.stop();
  });
  it('rejects outbound overload and retains a fixed queue bound', async () => {
    const gate=deferred();
    const s=scheduler({limits:{maxQueued:1},transmit:async entry=>{
      if(entry.recipient==='A1') await gate.promise;
      return true;
    }});
    const first=queue(s,{recipient:'A1'}), queued=queue(s,{recipient:'B2'});
    const excess=queue(s,{recipient:'C3'});
    expect(excess).toMatchObject({accepted:false,reason:'outbound_overloaded'});
    expect(s.status().queued).toBe(1);
    gate.resolve();await first.delivery;await queued.delivery;s.stop();
  });
  it('stopping a runtime terminates queued and in-progress replies without stale relays', async () => {
    const h=await make();
    const hold=h.hold(Buffer.alloc(640));h.synthesisReplies.push(hold.promise);
    const original=await h.begin('Central, en route');
    await finish(original);
    await until(()=>h.synthesize.mock.calls.length===1,'stalled speech');
    const startGeneration=h.runtime.runtimeGeneration;
    await h.runtime.stop();
    await h.runtime._outbound.whenIdle();
    await h.runtime.start();
    expect(h.runtime.runtimeGeneration).not.toBe(startGeneration);
    hold.resolve(Buffer.alloc(640));await Promise.resolve();
    expect(h.relay.injectAudio).not.toHaveBeenCalled();
    expect(h.runtime._outbound.status().speaking).toBe(0);
  });
  it('preserves recipient, channel and immutable turn in a queued output record', async () => {
    const h=await make();
    const turn=await h.begin('Central, available');
    await finish(turn);
    const history=h.diagnostics.record.mock.calls.map(([x])=>x).filter(x=>x.phase.startsWith('outbound_'));
    expect(history.length).toBeGreaterThan(0);
    expect(history.at(-1)).toMatchObject({details:{recipient:'A1',channel:h.context.roomKey}});
  });
  it('refuses stale generation and wrong-channel entries without calling a transmitter', async () => {
    const emitted=vi.fn(async()=>true);
    const s=scheduler({transmit:emitted,relevant:entry=>entry.channel===config.channel});
    const invalid=queue(s,{generation:'gen-old'});
    expect(invalid).toMatchObject({accepted:false,reason:'invalid_or_stale_output'});
    const wrong=queue(s,{channel:'other-center__OPS1'});
    expect((await wrong.delivery).status).toBe('expired');
    expect(emitted).not.toHaveBeenCalled();
    s.stop();
  });
  it('never marks failed radio injection as delivered', async () => {
    const s=scheduler({transmit:async()=>false});
    const turn=queue(s);
    expect((await turn.delivery).status).toBe('failed');
    expect(s.status().totals.completed).toBe(0);
    s.stop();
  });
  it('does not preempt another authorized speaker by forcing the radio floor', async () => {
    const h=await make();
    h.floor.requestFloor.mockReturnValue({granted:false,heldBy:'FIELD-2'});
    const queued=h.runtime._queueReply('Radio check', 'corr-busy', null);
    await vi.advanceTimersByTimeAsync(3100);
    expect((await queued.delivery).status).toBe('failed');
    expect(h.relay.injectAudio).not.toHaveBeenCalled();
    expect(h.floor.releaseFloor).not.toHaveBeenCalled();
  });
});
