import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../utils/api.js', () => ({
  notifyChannelJoin: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../signaling/SignalingManager.js', () => ({
  signalingManager: {
    signalPttStart: vi.fn(),
    signalPttEnd: vi.fn(),
    sendChannelData: vi.fn(),
  },
}));

vi.mock('../PcmPacket.js', () => ({
  buildPcmPacket: vi.fn(),
  buildBinaryFrame: vi.fn(),
  buildBinaryFrameOpus: vi.fn().mockReturnValue(new ArrayBuffer(0)),
  validatePcmPacket: vi.fn().mockReturnValue(false),
  parseBinaryAudioFrame: vi.fn().mockReturnValue(null),
}));

vi.mock('opus-decoder', () => ({
  OpusDecoder: vi.fn(function () {
    this.ready = Promise.resolve();
    this.decode = vi.fn();
    this.free = vi.fn();
  }),
}));

vi.mock('../PcmCaptureEngine.js', () => ({
  PcmCaptureEngine: vi.fn(function () {
    this.warmup = vi.fn().mockResolvedValue(undefined);
    this.stop = vi.fn().mockResolvedValue(undefined);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.prewarmAudioContext = vi.fn();
    this.onTrackEnded = null;
    this.init = vi.fn().mockResolvedValue(undefined);
  }),
}));

vi.mock('../PcmPlaybackEngine.js', () => ({
  PcmPlaybackEngine: vi.fn(function () {
    this.init = vi.fn().mockResolvedValue(undefined);
    this.ensureAudioContextResumed = vi.fn().mockResolvedValue(true);
    this.shutdown = vi.fn().mockResolvedValue(undefined);
    this.audioContext = null;
  }),
}));

vi.mock('../OpusBrowserEncoder.js', () => ({
  OpusBrowserEncoder: vi.fn(function () {
    this._ready = false;
    this.isReady = vi.fn(() => false);
    this.init = vi.fn().mockResolvedValue(true);
    this.destroy = vi.fn();
    this.flush = vi.fn().mockResolvedValue(undefined);
    this.encode = vi.fn();
    this.setOnEncoded = vi.fn();
  }),
}));

function makeMockEncoder() {
  let ready = false;
  return {
    isReady: vi.fn(() => ready),
    init: vi.fn(async () => { ready = true; return true; }),
    destroy: vi.fn(() => { ready = false; }),
    flush: vi.fn().mockResolvedValue(undefined),
    encode: vi.fn(),
    setOnEncoded: vi.fn(),
    setReadyState: (val) => { ready = val; },
  };
}

function makeOpenWebSocket() {
  const MockWebSocket = vi.fn(function (url) {
    this.readyState = 1;
    this.binaryType = '';
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.send = vi.fn();
    this.close = vi.fn();
    const self = this;
    setTimeout(() => { if (self.onopen) self.onopen({}); }, 0);
  });
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  return MockWebSocket;
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

async function buildManager() {
  const { LiveKitManager: AudioTransportManager } = await import('../AudioTransportManager.js');
  const manager = new AudioTransportManager();
  const mockEncoder = makeMockEncoder();
  manager._txEncoder = mockEncoder;
  return { manager, mockEncoder };
}

describe('AudioTransportManager — fast PTT start regression tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      location: { protocol: 'https:', host: 'localhost:3001' },
    });
    vi.stubGlobal('WebSocket', makeOpenWebSocket());
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('encoder is pre-warmed (init called) immediately after a successful connect()', async () => {
    const { manager, mockEncoder } = await buildManager();

    const connectPromise = manager.connect('ch1', 'unit-1');
    await vi.advanceTimersByTimeAsync(10);
    await connectPromise;
    await flushMicrotasks();

    expect(mockEncoder.init).toHaveBeenCalled();
  });

  it('encoder isReady() returns true within the connect() pre-warm window', async () => {
    const { manager, mockEncoder } = await buildManager();

    const connectPromise = manager.connect('ch1', 'unit-1');
    await vi.advanceTimersByTimeAsync(10);
    await connectPromise;
    await flushMicrotasks();

    expect(mockEncoder.isReady()).toBe(true);
  });

  it('encoder init() is NOT called during connect() when encoder is already ready', async () => {
    const { manager, mockEncoder } = await buildManager();

    mockEncoder.setReadyState(true);

    const connectPromise = manager.connect('ch1', 'unit-1');
    await vi.advanceTimersByTimeAsync(10);
    await connectPromise;
    await flushMicrotasks();

    expect(mockEncoder.init).not.toHaveBeenCalled();
  });

  it('stopTransmit() triggers encoder re-init in the background after transmission ends', async () => {
    const { manager, mockEncoder } = await buildManager();

    const { PTT_STATES } = await import('../../constants/pttStates.js');
    manager.pttState = PTT_STATES.TRANSMITTING;
    mockEncoder.setReadyState(true);

    await manager.stopTransmit();
    await flushMicrotasks();

    expect(mockEncoder.init).toHaveBeenCalled();
  });

  it('stopTransmit() re-warms encoder so isReady() is true before next PTT press', async () => {
    const { manager, mockEncoder } = await buildManager();

    const { PTT_STATES } = await import('../../constants/pttStates.js');
    manager.pttState = PTT_STATES.TRANSMITTING;
    mockEncoder.setReadyState(true);

    await manager.stopTransmit();
    await flushMicrotasks();

    expect(mockEncoder.isReady()).toBe(true);
  });

  it('stopTransmit() is a no-op when already IDLE — does not call encoder init', async () => {
    const { manager, mockEncoder } = await buildManager();

    await manager.stopTransmit();

    expect(mockEncoder.init).not.toHaveBeenCalled();
  });

  it('prewarmAudioContext() calls encoder init() when encoder is not ready', async () => {
    const { manager, mockEncoder } = await buildManager();

    mockEncoder.setReadyState(false);
    manager.prewarmAudioContext();
    await flushMicrotasks();

    expect(mockEncoder.init).toHaveBeenCalled();
  });

  it('prewarmAudioContext() skips encoder init() when encoder is already ready', async () => {
    const { manager, mockEncoder } = await buildManager();

    mockEncoder.setReadyState(true);
    manager.prewarmAudioContext();

    expect(mockEncoder.init).not.toHaveBeenCalled();
  });
});
