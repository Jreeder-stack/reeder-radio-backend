import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Real STT prohibited'); },
  textToSpeech: () => { throw new Error('Real TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Real paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Real model prohibited'); } } }));
import { V3TurnScheduler } from '../turnScheduler.js';
import { createHarness, START_TIME, finish, until } from './helpers/auditRuntimeHarness.js';
let fixtures;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-model');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unmocked network'); }));
  fixtures = [];
});
afterEach(async () => {
  try {
    for (const h of fixtures) await h.close();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
async function harness(options) { const h = await createHarness(options); fixtures.push(h); return h; }
const fakeIdentity = (turnId, speakerRef = 'A1', dispatchCenterId = 'center-a') => ({ turnId, speakerRef, dispatchCenterId });
const release = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const prepare = (transcript = 'Central, available') => async () => ({ transcript });
function reserved(s, id, unit) { const r = s.reserve(fakeIdentity(id, unit)); expect(r.accepted).toBe(true); return r.ticket; }

describe('01-03 actual PTT / CAD scheduling', () => {
  it('preserves capture order when the later A1 transcription finishes first', async () => {
    const h = await harness();
    const olderWords = h.hold('Central, en route');
    const first = await h.begin(olderWords.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'older STT');
    const second = await h.begin('Central, available');
    await until(() => h.transcribe.mock.calls.length === 2, 'newer STT');
    expect(h.writes('/api/radio/status')).toEqual([]);
    olderWords.resolve('Central, en route');
    await finish(first); await finish(second);
    expect(h.writes('/api/radio/status').map((request) => request.body.status)).toEqual(['en_route', 'available']);
    expect(h.cad.units[0].status).toBe('available');
  });
  it('lets B2 execute while A1 awaits STT and keeps its center and identity', async () => {
    const h = await harness();
    const stt = h.hold('Central, en route');
    const a = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'A1 STT');
    await h.send('Central, available', 'B2');
    expect(a.settled).toBe(false);
    expect(h.writes('/api/radio/status').map((r) => r.body.unit_id)).toEqual(['B2']);
    stt.resolve('Central, en route'); await finish(a);
    expect(h.writes('/api/radio/status').map((r) => r.body.unit_id)).toEqual(['B2', 'A1']);
  });
  it('expires queued A1 work behind an unresolved STT and prevents late CAD writes', async () => {
    const h = await harness();
    const stt = h.hold('Central, en route');
    const first = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'STT pending');
    const second = await h.begin('Central, available');
    await vi.advanceTimersByTimeAsync(31000);
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
    expect(h.writes()).toEqual([]);
    stt.resolve('Central, en route');
    await first.done; await second.done;
    expect(h.writes()).toEqual([]);
  });
  it('expires a second A1 command while first response synthesis is stalled', async () => {
    const h = await harness();
    const tts = h.hold(Buffer.alloc(640));
    h.synthesisReplies.push(tts.promise);
    const first = await h.begin('Central, en route');
    await until(() => h.synthesize.mock.calls.length === 1, 'first TTS');
    const second = await h.begin('Central, available');
    await vi.advanceTimersByTimeAsync(30001);
    expect(second.settled).toBe(true);
    expect(h.writes('/api/radio/status').map((r) => r.body.status)).toEqual(['en_route']);
    tts.resolve(Buffer.alloc(640)); await finish(first); await second.done;
    expect(h.writes('/api/radio/status').map((r) => r.body.status)).toEqual(['en_route']);
  });
  it('prevents pending transcription from executing after stop without claiming active-write rollback', async () => {
    const h = await harness();
    const stt = h.hold('Central, available');
    const turn = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'STT pending');
    await h.runtime.stop();
    stt.resolve('Central, available'); await finish(turn);
    expect(h.writes()).toEqual([]);
  });
  it('does not turn non-addressed traffic into a CAD write', async () => {
    const h = await harness();
    expect(await h.send('available')).toBe(false);
    expect(h.writes()).toEqual([]);
  });
  it('preserves 03-01 negation containment under sequencing', async () => {
    const h = await harness({ llmPlans: [{ action: 'NO_ACTION', input: {}, confidence: 1 }] });
    await h.send('Central, do not mark B2 available');
    expect(h.writes()).toEqual([]);
  });
});
describe('01-03 admission, global capacity, and bounded ticket lifecycle', () => {
  it('rejects ninth resident A1 turn without expanding the queue', () => {
    const s = new V3TurnScheduler();
    try {
      for (let i = 0; i < 8; i++) reserved(s, String(i), 'A1');
      expect(s.reserve(fakeIdentity('9', 'A1'))).toMatchObject({ accepted: false, reason: 'scheduler_overloaded' });
      expect(s.status().resident).toBe(8);
    } finally { s.stop(); }
  });
  it('limits shared residents across runtime scheduler instances', () => {
    const first = new V3TurnScheduler({ limits: { maxResident: 2 } });
    const second = new V3TurnScheduler({ limits: { maxResident: 2 } });
    try {
      reserved(first, '1', 'A1');
      reserved(second, '2', 'B2');
      expect(second.reserve(fakeIdentity('3', 'C3'))).toMatchObject({ accepted: false, reason: 'scheduler_overloaded' });
    } finally { first.stop(); second.stop(); }
    expect(first.status().globalResident).toBe(0);
  });
  it('isolates same callsign across centers', async () => {
    const s = new V3TurnScheduler();
    try {
      const a = s.reserve(fakeIdentity('a', 'A1', 'center-a')).ticket;
      const b = s.reserve(fakeIdentity('b', 'A1', 'center-b')).ticket;
      const order = [];
      const pa = s.complete(a, prepare(), async () => { order.push('a'); return true; });
      const pb = s.complete(b, prepare(), async () => { order.push('b'); return true; });
      expect((await pa).handled).toBe(true);
      expect((await pb).handled).toBe(true);
      expect(order).toHaveLength(2);
    } finally { s.stop(); }
  });
  it('waits for an earlier reserved turn and preserves two valid commands', async () => {
    const s = new V3TurnScheduler();
    const hold = release();
    try {
      const a = reserved(s, 'a', 'A1');
      const b = reserved(s, 'b', 'A1');
      const order = [];
      const first = s.complete(a, () => hold.promise, async () => { order.push('first'); return true; });
      const second = s.complete(b, prepare(), async () => { order.push('second'); return true; });
      await Promise.resolve(); await Promise.resolve();
      expect(order).toEqual([]);
      hold.resolve({ transcript: 'Central, en route' });
      expect((await first).handled).toBe(true);
      expect((await second).handled).toBe(true);
      expect(order).toEqual(['first', 'second']);
    } finally { s.stop(); }
  });
  it('bounds capture time and removes the abandoned reservation', async () => {
    const s = new V3TurnScheduler({ limits: { maxCaptureMs: 10 } });
    try {
      const a = reserved(s, 'a', 'A1');
      await vi.advanceTimersByTimeAsync(11);
      expect((await a.completion).reason).toBe('capture_expired');
      expect(s.status().resident).toBe(0);
    } finally { s.stop(); }
  });
  it('expires queued global lease requests without granting stale execution', async () => {
    const s = new V3TurnScheduler({ limits: { maxExecuting: 1, maxQueueWaitMs: 10 } });
    const hold = release();
    let executed = 0;
    try {
      const a = reserved(s, 'a', 'A1');
      const b = reserved(s, 'b', 'B2');
      const first = s.complete(a, prepare(), async () => { executed++; await hold.promise; return true; });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      const second = s.complete(b, prepare(), async () => { executed++; return true; });
      await vi.advanceTimersByTimeAsync(11);
      expect((await second).reason).toBe('queue_expired');
      expect(executed).toBe(1);
      hold.resolve();
      expect((await first).handled).toBe(true);
      expect(executed).toBe(1);
    } finally { hold.resolve(); s.stop(); }
  });
  it('does not free a timed-out STT permit until the provider settles', async () => {
    const s = new V3TurnScheduler({ limits: { maxPreparing: 1, maxQueueWaitMs: 10 } });
    const hold = release();
    try {
      const a = reserved(s, 'a', 'A1');
      const b = reserved(s, 'b', 'B2');
      const first = s.complete(a, () => hold.promise, async () => true);
      const second = s.complete(b, prepare(), async () => true);
      await vi.advanceTimersByTimeAsync(11);
      expect((await first).reason).toBe('queue_expired');
      expect((await second).reason).toBe('queue_expired');
      expect(s.status().globalPreparing).toBe(1);
      hold.resolve({ transcript: 'Central, available' });
      for (let i = 0; i < 5; i++) await Promise.resolve();
      expect(s.status().globalPreparing).toBe(0);
    } finally { hold.resolve({ transcript: 'late' }); s.stop(); }
  });
});
