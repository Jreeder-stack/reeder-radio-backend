import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({
  floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher',
}));
vi.mock('../../services/emergencyPagingService.js', () => ({
  pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); },
}));
vi.mock('openai', () => ({ AzureOpenAI: class {
  constructor() { throw new Error('Paid Azure model prohibited'); }
} }));

import { V3_CONVERSATION_ACTS, composeV3ConversationReply } from '../conversationReplies.js';
import { normalizeV3SemanticPlan } from '../semanticContract.js';
import { composeV3Response } from '../responseComposer.js';
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';

const conversational = act => ({
  intentType: 'conversation_only', action: 'NO_ACTION', input: {},
  conversationAct: act, confidence: 1,
});
let harnesses, network;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  network = vi.fn(() => { throw new Error('External network prohibited'); });
  vi.stubGlobal('fetch', network); harnesses = [];
});
afterEach(async () => {
  try {
    for (const h of harnesses) await h.close();
    expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});
async function make(options = {}) {
  const h = await createHarness(options); harnesses.push(h); return h;
}

describe('AI-DISP-V3-001 04-01 conversation-only on the existing V3 radio path', () => {
  it('replies to a presence check without executing any CAD action', async () => {
    const h = await make({ llmPlans: [conversational('presence')] });
    expect(await h.send('Central, are you there?')).toBe(true);
    expect(h.spoken()).toEqual(['A1, Central here. Go ahead.']);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
    expect(h.relay.injectAudio).toHaveBeenCalledTimes(1);
    expect(h.floor.releaseFloor).toHaveBeenCalledTimes(1);
    expect(h.diagnostics.record.mock.calls.some(([entry]) => entry.phase === 'conversation_only_reply_planned')).toBe(true);
  });

  it('supports basic acknowledgments and replies without needing an input phrase list', async () => {
    const h = await make({ llmPlans: [
      conversational('acknowledgement'),
      conversational('standby'), conversational('request_details'),
    ] });
    for (const words of [
      'Central, appreciate the information you gave me',
      'Central, remain ready for my next transmission',
      'Central, I need to ask about something else',
    ]) expect(await h.send(words)).toBe(true);
    expect(h.spoken()).toEqual([
      'A1, Copy.',
      'A1, Standing by for your next transmission.',
      'A1, Go ahead with the request or detail you need.',
    ]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it('answers channel and identity questions only from authenticated runtime context', async () => {
    const h = await make({ llmPlans: [conversational('channel'), conversational('identity')] });
    await h.send('Central, which channel have I reached?');
    await h.send('Central, is this a human dispatcher?');
    expect(h.spoken()).toEqual([
      'A1, You are on OPS1.',
      'A1, This is the automated dispatcher. Go ahead.',
    ]);
    expect(h.writes()).toEqual([]);
  });

  it('honestly describes supported assistance without granting tools or promising data', async () => {
    const h = await make({ scopes: ['unit.read', 'call.read'], llmPlans: [
      conversational('capabilities'),
    ] });
    await h.send('Central, what sort of assistance can I request?');
    expect(h.spoken().at(-1)).toMatch(/supported radio and CAD requests when authorized/i);
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });

  it('does not speak an observation or quoted prohibition as a conversation reply', async () => {
    const h = await make({ llmPlans: [
      { action: 'NO_ACTION', intentType: 'observation', input: {}, confidence: 1 },
    ] });
    await h.send("Central, I said 'mark B2 on scene' earlier, don't do it.");
    expect(h.spoken()).toEqual([]);
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });

  it('legacy implicit NO_ACTION stays silent while explicit conversation only remains heard', async () => {
    const h = await make({ llmPlans: [
      { action: 'NO_ACTION', confidence: 1, input: {} },
      { action: 'NO_ACTION', intentType: 'conversation_only', confidence: 1, input: {} },
    ] });
    await h.send('Central, this is a non-actionable observation');
    await h.send('Central, understood, thanks');
    expect(h.spoken()).toEqual(['A1, Copy.']);
  });

  it('ignores other-unit chatter even if a model could have answered it', async () => {
    const h = await make({ llmPlans: [conversational('presence')] });
    expect(await h.send('B2, tell the supervisor when you are ready', 'A1')).toBe(false);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.spoken()).toEqual([]);
    expect(h.writes()).toEqual([]);
  });

  it('contains conversation replies within each authenticated unit and center', async () => {
    const a = await make({ center: 'center-a', llmPlans: [
      conversational('presence'), conversational('channel'),
    ] });
    const b = await make({ center: 'center-b', llmPlans: [
      conversational('identity'),
    ] });
    await a.send('Central, are you receiving?','A1');
    await b.send('Central, who is this?','B2');
    await a.send('Central, which channel?','B2');
    expect(a.spoken()).toEqual([
      'A1, Central here. Go ahead.', 'B2, You are on OPS1.',
    ]);
    expect(b.spoken()).toEqual(['B2, This is the automated dispatcher. Go ahead.']);
    expect(a.writes()).toEqual([]); expect(b.writes()).toEqual([]);
  });

  it('preserves ordinary deterministic radio checks and authorized CAD writes', async () => {
    const h = await make({ llmPlans: [conversational('presence')] });
    await h.send('Central, are you there?');
    await h.send('Central, radio check');
    await h.send('Central, available');
    expect(h.spoken().at(0)).toMatch(/Central here/);
    expect(h.spoken().at(1)).toMatch(/loud and clear/);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect((await h.lastResult()).data.verified).toBe(true);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  });

  it('rejects model conversation acts on mutations, observations and compounds', () => {
    for (const raw of [
      { intentType: 'action_request', action: 'SET_UNIT_STATUS',
        input: { unitRef: 'A1', status: 'available' }, conversationAct: 'presence' },
      { intentType: 'observation', action: 'NO_ACTION', input: {}, conversationAct: 'acknowledgement' },
      { intentType: 'action_request', actions: [
        { action: 'STATUS_CHECK', input: { unitRef: 'A1' } },
      ], conversationAct: 'presence' },
    ]) expect(() => normalizeV3SemanticPlan(raw)).toThrow(/conversation|conversational/i);
  });

  it('never speaks invented or arbitrary model-authored claims', () => {
    expect(V3_CONVERSATION_ACTS).toHaveLength(7);
    const plan = normalizeV3SemanticPlan({
      ...conversational('acknowledgement'),
      replyText: 'CAD confirms all the emergency lights are on',
      authorized: true,
    });
    expect(plan).not.toHaveProperty('replyText');
    expect(plan).not.toHaveProperty('authorized');
    expect(composeV3Response({ plan, speakerCallsign: 'A1', channelName: 'OPS1' }))
      .toBe('A1, Copy.');
    expect(() => normalizeV3SemanticPlan(conversational('invented_success')))
      .toThrow(/conversational response type/i);
    expect(composeV3ConversationReply({ act: 'fake', speakerCallsign: 'A1' })).toBeNull();
  });

  it('respects a bounded text limit even if trusted channel metadata is excessively long', () => {
    const result = composeV3ConversationReply({
      act: 'channel', speakerCallsign: 'A'.repeat(100),
      channelName: 'OPS-'.repeat(100),
    });
    expect(result.length).toBeLessThanOrEqual(210);
    expect(result).not.toContain('A'.repeat(100));
  });
});
