import { describe, expect, it, vi } from 'vitest';
import { V3LiveDispatcher } from '../liveRuntime.js';

const context = {
  runtimeId: 'runtime-floor',
  profileId: 'profile-floor',
  dispatchCenterId: 'center-floor',
  channelId: 7,
  channelName: 'OPS 1',
  roomKey: 'Zone1__OPS1',
  identity: 'AI-DISPATCHER:FLOOR',
  cadUrl: 'https://cad.example.test',
  cadApiKey: 'secret',
};

function makeRuntime({ floorControl, audioRelay } = {}) {
  const floor = floorControl || {
    requestFloor: vi.fn(() => ({ granted: true })),
    releaseFloor: vi.fn(() => true),
    releaseAllForUnit: vi.fn(),
  };
  const relay = audioRelay || {
    addAudioListener: vi.fn(),
    removeAllAudioListeners: vi.fn(),
    hasRecentInbound: vi.fn(() => null),
    injectAudio: vi.fn(),
  };
  const codec = {
    encodePcmToOpus: vi.fn(() => [Buffer.from([1]), Buffer.from([2])]),
    decodeOpusToPcm: vi.fn(),
    releaseSenderDecoder: vi.fn(),
  };
  const signaling = { io: {}, emergencyStates: new Map(), unitPresence: new Map(), publishAiRadioAudio: vi.fn(() => true) };
  const runtime = new V3LiveDispatcher({
    runtimeContext: context,
    scopes: ['unit.read', 'unit.write', 'call.read', 'call.write'],
    synthesize: vi.fn(async () => Buffer.alloc(640)),
    audioRelay: relay,
    codec,
    floorControl: floor,
    signaling,
    planner: { plan: vi.fn() },
  });
  return { runtime, floor, relay, codec, signaling };
}

describe('V3LiveDispatcher outbound floor control', () => {
  it('acquires the AI floor, transmits, and releases it', async () => {
    const { runtime, floor, relay, signaling } = makeRuntime();
    const sent = await runtime._speak('Indiana 1, copy.', 'corr-floor');
    expect(sent).toBe(true);
    expect(floor.requestFloor).toHaveBeenCalledWith('Zone1__OPS1', 'AI-Dispatcher');
    expect(relay.injectAudio).toHaveBeenCalledTimes(2);
    expect(floor.releaseFloor).toHaveBeenCalledWith('Zone1__OPS1', 'AI-Dispatcher');
    expect(floor.releaseAllForUnit).not.toHaveBeenCalled();
    expect(signaling.publishAiRadioAudio).toHaveBeenNthCalledWith(1,
      'Zone1__OPS1', 'AI-DISPATCHER:FLOOR', true);
    expect(signaling.publishAiRadioAudio).toHaveBeenNthCalledWith(2,
      'Zone1__OPS1', 'AI-DISPATCHER:FLOOR', false);
    expect(signaling.publishAiRadioAudio.mock.invocationCallOrder[0])
      .toBeLessThan(relay.injectAudio.mock.invocationCallOrder[0]);
    expect(signaling.publishAiRadioAudio.mock.invocationCallOrder[1])
      .toBeGreaterThan(floor.releaseFloor.mock.invocationCallOrder[0]);
  });

  it('always releases the floor when audio injection fails', async () => {
    const floor = {
      requestFloor: vi.fn(() => ({ granted: true })),
      releaseFloor: vi.fn(() => true),
      releaseAllForUnit: vi.fn(),
    };
    const relay = {
      addAudioListener: vi.fn(),
      removeAllAudioListeners: vi.fn(),
      hasRecentInbound: vi.fn(() => null),
      injectAudio: vi.fn(() => { throw new Error('relay failed'); }),
    };
    const { runtime, signaling } = makeRuntime({ floorControl: floor, audioRelay: relay });
    const sent = await runtime._speak('test', 'corr-error');
    expect(sent).toBe(false);
    expect(floor.releaseFloor).toHaveBeenCalledWith('Zone1__OPS1', 'AI-Dispatcher');
    expect(signaling.publishAiRadioAudio).toHaveBeenCalledWith('Zone1__OPS1', 'AI-DISPATCHER:FLOOR', false);
  });

  it('does not transmit when the radio floor remains busy', async () => {
    vi.useFakeTimers();
    try {
      const floor = {
        requestFloor: vi.fn(() => ({ granted: false, heldBy: 'INDIANA-2' })),
        releaseFloor: vi.fn(),
        releaseAllForUnit: vi.fn(),
      };
      const relay = {
        addAudioListener: vi.fn(),
        removeAllAudioListeners: vi.fn(),
        hasRecentInbound: vi.fn(() => null),
        injectAudio: vi.fn(),
      };
      const { runtime, signaling } = makeRuntime({ floorControl: floor, audioRelay: relay });
      const promise = runtime._speak('test', 'corr-busy');
      await vi.advanceTimersByTimeAsync(3200);
      const sent = await promise;
      expect(sent).toBe(false);
      expect(relay.injectAudio).not.toHaveBeenCalled();
      expect(floor.releaseFloor).not.toHaveBeenCalled();
      expect(signaling.publishAiRadioAudio).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
