import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(320)),
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
  getAiDispatchChannel: async () => null,
  createChannelMessage: async () => null,
}));

let AIDispatcher;
let floorControlService;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
  ({ floorControlService } = await import('../floorControlService.js'));
});

describe('TTS reply serialization through speak queue', () => {
  it('serializes two near-simultaneous speak() calls in order via the speak queue', async () => {
    const d = new AIDispatcher();
    d.connected = true;
    d.isRunning = true;
    d.channelName = 'CH-TEST';

    const order = [];
    let inFlight = 0;
    let maxConcurrent = 0;
    d.publishAudio = async (_audio, text) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      order.push(`start:${text}`);
      await new Promise(r => setTimeout(r, 30));
      order.push(`end:${text}`);
      inFlight--;
    };

    const p1 = d.speak('first ack', 'Indiana-1');
    const p2 = d.speak('second ack', 'Chester-2');

    await Promise.all([p1, p2]);

    expect(order).toEqual([
      'start:first ack',
      'end:first ack',
      'start:second ack',
      'end:second ack',
    ]);
    expect(maxConcurrent).toBe(1);
  });

  it('both speak() calls go through publishAudio (none are dropped)', async () => {
    const d = new AIDispatcher();
    d.connected = true;
    d.isRunning = true;
    d.channelName = 'CH-TEST';

    const calls = [];
    d.publishAudio = async (_a, text) => { calls.push(text); };

    await Promise.all([
      d.speak('ack one', 'U-1'),
      d.speak('ack two', 'U-2'),
      d.speak('ack three', 'U-3'),
    ]);

    expect(calls).toEqual(['ack one', 'ack two', 'ack three']);
  });

  it('passes retryOnBusy=true into publishAudio so requestFloor is retried instead of dropped', async () => {
    const d = new AIDispatcher();
    d.connected = true;
    d.isRunning = true;
    d.channelName = 'CH-TEST';

    const seenOptions = [];
    d.publishAudio = async (_a, _text, opts) => { seenOptions.push(opts); };

    await d.speak('hello', 'U-1');
    expect(seenOptions[0].retryOnBusy).toBe(true);
  });
});
