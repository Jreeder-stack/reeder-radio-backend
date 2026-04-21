import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../iosAudioUnlock.js', () => {
  let resolveAddModule;
  const addModule = vi.fn(() => new Promise((resolve) => { resolveAddModule = resolve; }));
  const ctx = {
    sampleRate: 16000,
    state: 'running',
    audioWorklet: { addModule },
    destination: {},
    resume: vi.fn().mockResolvedValue(undefined),
    createGain: vi.fn(() => ({
      gain: { value: 1.0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    })),
    createScriptProcessor: vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    })),
  };
  return {
    getSharedAudioContext: () => ctx,
    __ctx: ctx,
    __resolveAddModule: () => resolveAddModule(),
  };
});

vi.mock('../radioVoiceDSP.js', () => ({
  processRadioVoice: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
  cleanup: vi.fn(),
  updateSettings: vi.fn(),
}));

describe('PcmPlaybackEngine — init race / pending-frame buffering (Task #380)', () => {
  let workletPosts;
  let unlockMod;

  beforeEach(async () => {
    workletPosts = [];
    vi.clearAllMocks();

    vi.stubGlobal('AudioWorkletNode', vi.fn(function () {
      this.port = {
        postMessage: vi.fn((msg) => workletPosts.push(msg)),
        onmessage: null,
      };
      this.connect = vi.fn();
      this.disconnect = vi.fn();
    }));

    vi.resetModules();
    unlockMod = await import('../iosAudioUnlock.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('buffers frames enqueued during init() and flushes them in order once the worklet is ready', async () => {
    const { PcmPlaybackEngine } = await import('../PcmPlaybackEngine.js');
    const engine = new PcmPlaybackEngine();

    // Packet 1 arrives — kicks off init() (addModule promise is pending).
    engine.enqueue(new Int16Array([1, 1, 1]));
    // Packets 2..N arrive while addModule is still loading — must NOT drop.
    engine.enqueue(new Int16Array([2, 2, 2]));
    engine.enqueue(new Int16Array([3, 3, 3]));
    engine.enqueue(new Int16Array([4, 4, 4]));

    // Let init() advance to the awaited addModule().
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Nothing has reached the worklet yet (worklet doesn't exist).
    expect(workletPosts.length).toBe(0);

    // Worklet finishes loading.
    unlockMod.__resolveAddModule();
    // Allow init() to finish.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(engine.started).toBe(true);
    // All four buffered frames must have been delivered, in order.
    expect(workletPosts.length).toBe(4);
    expect(Array.from(workletPosts[0].samples)).toEqual([1, 1, 1]);
    expect(Array.from(workletPosts[1].samples)).toEqual([2, 2, 2]);
    expect(Array.from(workletPosts[2].samples)).toEqual([3, 3, 3]);
    expect(Array.from(workletPosts[3].samples)).toEqual([4, 4, 4]);

    // Subsequent enqueues bypass the buffer and post directly.
    await engine.enqueue(new Int16Array([5, 5, 5]));
    expect(workletPosts.length).toBe(5);
    expect(Array.from(workletPosts[4].samples)).toEqual([5, 5, 5]);
  });

  it('init() is idempotent — concurrent callers share the same in-flight init promise', async () => {
    const { PcmPlaybackEngine } = await import('../PcmPlaybackEngine.js');
    const engine = new PcmPlaybackEngine();

    const p1 = engine.init();
    const p2 = engine.init();
    const p3 = engine.init();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Same in-flight promise re-used while addModule is pending.
    expect(p2).toBe(p1);
    expect(p3).toBe(p1);

    unlockMod.__resolveAddModule();
    await Promise.all([p1, p2, p3]);

    expect(engine.started).toBe(true);
    // addModule called exactly once.
    expect(unlockMod.__ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1);
  });
});
