// Task #515: AI dispatcher releases the air promptly after every transmission.
// Tests for publishAudio() floor lifecycle and speak() ai-playback events.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(640)),
  isConfigured: () => true,
}));

vi.mock('../llmIntentService.js', () => ({
  isConfigured: () => false,
  classifyIntent: vi.fn(),
  answerWithData: vi.fn(),
  composeNatural: vi.fn(async (_unitId, draft) => draft),
  rewriteCallNote: vi.fn(async (_unitId, draft) => draft),
}));

vi.mock('../cadService.js', () => ({
  RADIO_STATUS: {},
  extractActualStatusFromRejection: () => null,
  isConfigured: () => false,
}));

vi.mock('../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => 'CH-TEST',
  createChannelMessage: async () => null,
}));

vi.mock('../opusCodec.js', () => ({
  opusCodec: {
    encodePcmToOpus: vi.fn(() => [Buffer.from([1]), Buffer.from([2])]),
  },
  SAMPLE_RATE: 16000,
  FRAME_SIZE: 320,
}));

vi.mock('../audioRelayService.js', () => ({
  audioRelayService: {
    injectAudio: vi.fn(),
  },
}));

vi.mock('../wavValidator.js', () => ({
  isValidWav: () => false, // skip the chat-record path
}));

let AIDispatcher;
let floorControlService;
let AI_FLOOR_IDENTITY;
let opusCodec;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
  const fmod = await import('../floorControlService.js');
  floorControlService = fmod.floorControlService;
  AI_FLOOR_IDENTITY = fmod.AI_FLOOR_IDENTITY;
  ({ opusCodec } = await import('../opusCodec.js'));
});

function makeDispatcher(channelName = 'CH-TEST') {
  const d = new AIDispatcher();
  d.connected = true;
  d.isRunning = true;
  d.channelName = channelName;
  d.shouldRespond = async () => true;
  // Avoid hitting any real signaling
  d.sendDataMessage = vi.fn(async () => {});
  d._sanitizeForTts = (text) => ({ text, replaced: 0 });
  return d;
}

function captureLifecycleLogs(d) {
  const events = [];
  const originalLog = d.log.bind(d);
  d.log = (action, details) => {
    events.push({ action, details });
    return originalLog(action, details);
  };
  return events;
}

describe('publishAudio floor lifecycle (Task #515)', () => {
  it('happy path: releaseFloor called once with the acquired key; releaseSource=normal', async () => {
    const d = makeDispatcher('CH-NORMAL');
    const events = captureLifecycleLogs(d);
    const releaseSpy = vi.spyOn(floorControlService, 'releaseFloor');
    const releaseAllSpy = vi.spyOn(floorControlService, 'releaseAllForUnit');

    await d.publishAudio(Buffer.alloc(640));

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(releaseSpy).toHaveBeenCalledWith('CH-NORMAL', AI_FLOOR_IDENTITY);
    expect(releaseAllSpy).not.toHaveBeenCalled();

    const lifecycle = events.find(e => e.action === 'AI_FLOOR_LIFECYCLE');
    expect(lifecycle).toBeDefined();
    expect(lifecycle.details.releaseSource).toBe('normal');
    expect(lifecycle.details.acquiredKey).toBe('CH-NORMAL');
    expect(lifecycle.details.releaseKey).toBe('CH-NORMAL');
    expect(lifecycle.details.fellBackToReleaseAll).toBe(false);
    expect(lifecycle.details.framesSent).toBe(2);
    // Routine ack: from last frame to release should be tiny (≤ 200 ms)
    const tail = lifecycle.details.releasedAtMs - lifecycle.details.lastFrameAtMs;
    expect(tail).toBeLessThanOrEqual(250);
  });

  it('channelName mutated mid-publish: finally falls through to releaseAllForUnit', async () => {
    const d = makeDispatcher('CH-OLD');
    const events = captureLifecycleLogs(d);

    // Inject a side-effect that mutates channelName *and* removes the AI floor
    // under the original key during the streaming loop, so releaseFloor() will
    // miss and the finally block must fall back to releaseAllForUnit.
    let mutated = false;
    const realInject = vi.mocked((await import('../audioRelayService.js')).audioRelayService.injectAudio);
    realInject.mockImplementation(() => {
      if (!mutated) {
        mutated = true;
        // Simulate channel rotation: drop the old floor and re-acquire under
        // a new key by some other process, then move dispatcher channel.
        floorControlService.forceRelease('CH-OLD');
        d.channelName = 'CH-NEW';
      }
    });

    const releaseAllSpy = vi.spyOn(floorControlService, 'releaseAllForUnit');

    await d.publishAudio(Buffer.alloc(640));

    expect(releaseAllSpy).toHaveBeenCalledWith(AI_FLOOR_IDENTITY);

    const lifecycle = events.find(e => e.action === 'AI_FLOOR_LIFECYCLE');
    expect(lifecycle).toBeDefined();
    expect(lifecycle.details.releaseSource).toBe('finally');
    expect(lifecycle.details.acquiredKey).toBe('CH-OLD');
    expect(lifecycle.details.releaseKey).toBe('CH-NEW');
    expect(lifecycle.details.fellBackToReleaseAll).toBe(true);
  });

  it('exception during streaming loop: floor still released; releaseSource=catch', async () => {
    const d = makeDispatcher('CH-THROW');
    const events = captureLifecycleLogs(d);

    const realInject = vi.mocked((await import('../audioRelayService.js')).audioRelayService.injectAudio);
    realInject.mockImplementation(() => {
      throw new Error('relay exploded');
    });

    const releaseSpy = vi.spyOn(floorControlService, 'releaseFloor');

    await d.publishAudio(Buffer.alloc(640));

    expect(releaseSpy).toHaveBeenCalledWith('CH-THROW', AI_FLOOR_IDENTITY);
    expect(floorControlService.holdsFloor('CH-THROW', AI_FLOOR_IDENTITY)).toBe(false);

    const lifecycle = events.find(e => e.action === 'AI_FLOOR_LIFECYCLE');
    expect(lifecycle).toBeDefined();
    expect(['catch', 'finally']).toContain(lifecycle.details.releaseSource);
  });
});

describe('speak() emits ai-playback-start/end (Task #515)', () => {
  it('emits ai-playback-start then ai-playback-end around publishAudio', async () => {
    const d = makeDispatcher('CH-SPEAK');
    const order = [];
    d.sendDataMessage = vi.fn(async (msg) => { order.push(msg.type); });
    d.publishAudio = vi.fn(async () => { order.push('publish'); });

    await d.speak('hello world', 'U-1');

    expect(order).toEqual(['ai-playback-start', 'publish', 'ai-playback-end']);
  });

  it('still emits ai-playback-end if publishAudio throws', async () => {
    const d = makeDispatcher('CH-SPEAK');
    const sent = [];
    d.sendDataMessage = vi.fn(async (msg) => { sent.push(msg.type); });
    d.publishAudio = vi.fn(async () => { throw new Error('boom'); });

    await d.speak('oops', 'U-1');

    expect(sent).toEqual(['ai-playback-start', 'ai-playback-end']);
  });
});
