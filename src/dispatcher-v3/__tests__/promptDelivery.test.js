import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model prohibited'); } } }));

import { V3ConversationGate } from '../conversationGate.js';
import { createHarness, finish, until, START_TIME, NO_ACTION } from './helpers/auditRuntimeHarness.js';

const question = () => ({
  action: 'CLARIFY', confidence: 1, input: {},
  clarification: 'Which incident are you referring to?',
});
const assign = () => ({ action: 'ASSIGN_UNIT', confidence: 1, input: { unitRef: 'A1', callRef: 'that call' } });
const answer = (id = 'OLD-CALL') => ({ action: 'ASSIGN_UNIT', confidence: 1, input: { callId: id } });
const speaker = (h, unit = 'A1') => h.runtime.conversationGate.pendingFor(unit);
const scope = {
  sessionKey: 'session-A1', conversationId: 'conversation-A1',
  taskId: 'task-A1', promptTurnId: 'first-turn', runtimeGeneration: 'generation-1',
  channelId: 'center-a__OPS1',
};
let harnesses, networkGuard;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-no-network');
  networkGuard = vi.fn(() => { throw new Error('External network prohibited in 02-03'); });
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
async function make(options = {}) { const h = await createHarness(options); harnesses.push(h); return h; }

describe('AI-DISP-V3-001 02-03 delivery-correlated follow-up gate', () => {
  it('never opens a window at question creation, even if more than 30 seconds elapse while waiting for output', () => {
    let now = 1_000;
    const gate = new V3ConversationGate({ now: () => now, pendingMs: 30_000 });
    const pending = gate.expectFollowUp('A1', { ...scope, clarification: 'Which call?' });
    expect(pending).toMatchObject({ promptState: 'awaiting_delivery', expiresAt: null, deliveredAt: null });
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'OLD-CALL' })).toMatchObject({
      allowed: false, reason: 'prompt_not_delivered',
    });
    now += 35_000;
    expect(gate.settlePromptDelivery({ ...scope, unitId: 'A1', status: 'completed' })).toBe(true);
    expect(pending.deliveredAt).toBe(now);
    expect(pending.expiresAt).toBe(now + 30_000);
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'OLD-CALL' })).toMatchObject({
      allowed: true, reason: 'follow_up', pending,
    });
    now += 30_001;
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'OLD-CALL' })).toMatchObject({
      allowed: false, reason: 'prompt_expired',
    });
  });

  it('only the exact session/task/turn/channel/generation receipt can arm the prompt, once', () => {
    let now = 100;
    const gate = new V3ConversationGate({ now: () => now });
    const pending = gate.expectFollowUp('A1', { ...scope, clarification: 'Which call?' });
    for (const mutation of [
      { unitId: 'B2' }, { sessionKey: 'foreign-socket' }, { conversationId: 'foreign-conversation' },
      { taskId: 'foreign-task' }, { promptTurnId: 'old-prompt' },
      { runtimeGeneration: 'old-generation' }, { channelId: 'other-center__OPS1' },
    ]) {
      expect(gate.settlePromptDelivery({ ...scope, unitId: 'A1', status: 'completed', ...mutation })).toBe(false);
    }
    expect(pending.promptState).toBe('awaiting_delivery');
    expect(gate.settlePromptDelivery({ ...scope, unitId: 'A1', status: 'completed' })).toBe(true);
    const originallyDelivered = pending.deliveredAt;
    now += 2_000;
    expect(gate.settlePromptDelivery({ ...scope, unitId: 'A1', status: 'completed' })).toBe(false);
    expect(pending.deliveredAt).toBe(originallyDelivered);
    expect(gate.isCurrentPending('A1', pending)).toBe(true);
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'OLD-CALL', taskId: 'other-task' })).toMatchObject({
      allowed: false, reason: 'pending_task_changed',
    });
    expect(Boolean(gate.pendingFor('A1'))).toBe(false);
  });

  it.each(['failed', 'interrupted', 'expired'])('%s output cannot open a reply window', (status) => {
    const gate = new V3ConversationGate();
    const original = gate.expectFollowUp('A1', { ...scope });
    expect(gate.settlePromptDelivery({ ...scope, unitId: 'A1', status })).toBe(true);
    expect(gate.isCurrentPending('A1', original)).toBe(false);
    expect(Boolean(gate.pendingFor('A1'))).toBe(false);
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'OLD-CALL' }).allowed).toBe(false);
  });

  it('fails closed on an incomplete ownership token and does not use old creation-time timers', () => {
    const gate = new V3ConversationGate();
    expect(gate.expectFollowUp('A1', { clarification: 'Which call?' })).toBeNull();
    expect(gate.pending.size).toBe(0);
    expect(gate.settlePromptDelivery({ ...scope, unitId: 'A1', status: 'completed' })).toBe(false);
  });

  it('preserves an intact delivered prompt through unrelated radio traffic and a foreign session', () => {
    const gate = new V3ConversationGate();
    const pending = gate.expectFollowUp('A1', { ...scope });
    gate.settlePromptDelivery({ ...scope, unitId: 'A1', status: 'completed' });
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'B2, move to TAC 1' })).toMatchObject({
      allowed: false, reason: 'unit_to_unit',
    });
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'unit 2, report to station' })).toMatchObject({
      allowed: false, reason: 'unit_to_unit',
    });
    expect(gate.shouldProcess({ ...scope, sessionKey: 'different-session', unitId: 'A1', transcript: 'OLD-CALL' }).allowed).toBe(false);
    expect(gate.isCurrentPending('A1', pending)).toBe(true);
    expect(gate.shouldProcess({ ...scope, unitId: 'A1', transcript: 'OLD-CALL' })).toMatchObject({
      allowed: true, reason: 'follow_up',
    });
  });
});

describe('AI-DISP-V3-001 02-03 actual V3 transmission and CAD path', () => {
  it('R11: a delayed but completed question gives the unit the full 30 seconds after delivery', async () => {
    const h = await make({ llmPlans: [question(), NO_ACTION] });
    const tts = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(tts.promise);
    const q = await h.begin('Central, please clarify the incident I mentioned');
    await until(() => h.synthesize.mock.calls.length === 1, 'delayed question synthesis');
    const pending = speaker(h);
    expect(pending).toMatchObject({ promptState: 'awaiting_delivery', expiresAt: null });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending.promptState).toBe('awaiting_delivery');
    tts.resolve(Buffer.alloc(640)); await finish(q); await h.flushOutput();
    expect(pending.promptState).toBe('delivered');
    expect(pending.expiresAt).toBe(pending.deliveredAt + 30_000);
    expect(h.relay.injectAudio).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(22_000);
    expect(Date.now() - pending.createdAt).toBeGreaterThan(30_000);
    expect(await h.send('the alarm')).toBe(true);
    expect(h.llm).toHaveBeenCalledTimes(2);
    expect(h.writes()).toEqual([]);
  });

  it('a busy-channel queued question is tracked from its actual transmission, not from creation', async () => {
    const h = await make({ llmPlans: [question(), NO_ACTION] });
    const tts = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(tts.promise);
    await finish(await h.begin('Central, mark me available', 'B2'));
    await until(() => h.synthesize.mock.calls.length === 1, 'B2 occupying output lane');
    await finish(await h.begin('Central, which call were we discussing', 'A1'));
    const pending = speaker(h);
    expect(pending).toMatchObject({ promptState: 'awaiting_delivery', expiresAt: null });
    await vi.advanceTimersByTimeAsync(8_000);
    tts.resolve(Buffer.alloc(640)); await h.flushOutput();
    expect(pending.promptState).toBe('delivered');
    expect(h.spoken()).toContain('Which incident are you referring to?');
    await vi.advanceTimersByTimeAsync(23_000);
    expect(Date.now() - pending.createdAt).toBeGreaterThan(30_000);
    expect(await h.send('the Walmart alarm')).toBe(true);
    expect(h.llm).toHaveBeenCalledTimes(2);
  });

  it('a response while the question is still synthesizing is not treated as a heard prompt', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    const tts = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(tts.promise);
    const first = await h.begin('Central, put me on that call');
    await until(() => h.synthesize.mock.calls.length === 1, 'pending question synthesis');
    expect(speaker(h)?.promptState).toBe('awaiting_delivery');
    expect(await finish(await h.begin('OLD-CALL'))).toBe(false);
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    tts.resolve(Buffer.alloc(640)); await finish(first); await h.flushOutput();
    expect(speaker(h)).toBeUndefined();
    expect(h.writes()).toEqual([]);
  });

  it('an interrupted question never becomes a heard prompt', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    const tts = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(tts.promise);
    const q = await h.begin('Central, put me on that call');
    await until(() => h.synthesize.mock.calls.length === 1, 'blocked speech');
    const pending = speaker(h), id = pending.promptTurnId;
    expect(h.runtime._outbound.cancelByTurn(id, 'emergency_priority')).toBe(1);
    await h.flushOutput();
    expect(speaker(h)).toBeUndefined();
    expect(pending.promptState).toBe('awaiting_delivery');
    expect(await h.send('OLD-CALL')).toBe(false);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    tts.resolve(Buffer.alloc(640)); await finish(q);
  });

  it('a failed radio-floor acquisition cannot start an answer window', async () => {
    const h = await make({ llmPlans: [assign()] });
    h.floor.requestFloor.mockReturnValue({ granted: false, heldBy: 'other-unit' });
    const q = await h.begin('Central, put me on that call');
    await until(() => speaker(h)?.promptState === 'awaiting_delivery', 'floor-blocked question registration');
    await vi.advanceTimersByTimeAsync(3_100);
    await finish(q); await h.flushOutput();
    expect(speaker(h)).toBeUndefined();
    expect(h.relay.injectAudio).not.toHaveBeenCalled();
    expect(await h.send('OLD-CALL')).toBe(false);
    expect(h.writes()).toEqual([]);
  });

  it('a queued question expiring without being transmitted cannot arm a follow-up', async () => {
    const h = await make({ llmPlans: [assign()] });
    // Keep B2's output lane occupied with many frames, not an illegal 20s
    // stalled TTS. The existing 12s synthesis bound must remain effective.
    h.codec.encodePcmToOpus.mockReturnValueOnce(
      Array.from({ length: 1_100 }, () => Buffer.from([1])),
    );
    await finish(await h.begin('Central, mark me available', 'B2'));
    await until(() => h.relay.injectAudio.mock.calls.length > 0, 'long B2 transmission');
    await finish(await h.begin('Central, put me on that call'));
    expect(speaker(h)?.promptState).toBe('awaiting_delivery');
    await vi.advanceTimersByTimeAsync(20_100);
    await h.flushOutput();
    expect(speaker(h)).toBeUndefined();
    expect(await h.send('OLD-CALL')).toBe(false);
    expect(h.writes('/api/radio/assign')).toEqual([]);
  });

  it('an A1 follow-up belongs only to its delivered conversation despite B2/C3 traffic', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    await h.send('Central, put me on that call', 'A1');
    const pending = speaker(h);
    const foreign = await h.principal('A1', { connectionId: 'other-socket' });
    const foreignCapture = await h.capture('A1', { principal: foreign });
    h.frame(foreignCapture);
    expect(await finish(h.end(foreignCapture, 'NEW-CALL'))).toBe(false);
    await h.send('B2, switch to TAC 1', 'A1').then(result => expect(result).toBe(false));
    await h.send('Central, radio check', 'B2');
    await h.send('Central, radio check', 'C3');
    expect(speaker(h)).toBe(pending);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(await h.send('OLD-CALL', 'A1')).toBe(true);
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
    expect(h.writes('/api/radio/assign')[0].body.call_id).toBe('OLD-CALL');
  });

  it('a re-clarification is tied to the same original task, with a new delivered question', async () => {
    const h = await make({ llmPlans: [
      assign(),
      { action: 'CLARIFY', input: {}, confidence: 1, clarification: 'Which call, the Walmart alarm or traffic stop?' },
      answer('NEW-CALL'),
    ] });
    await h.send('Central, put me on that call');
    const first = speaker(h), originalId = first.originalTurnId;
    expect(await h.send('I cannot tell from that')).toBe(true);
    const second = speaker(h);
    expect(second.promptTurnId).not.toBe(first.promptTurnId);
    expect(second.originalTurnId).toBe(originalId);
    expect(second.taskId).toBe(first.taskId);
    expect(second.promptState).toBe('delivered');
    expect(second).not.toHaveProperty('clarification');
    expect(h.runtime.conversations.conversations.get(second.sessionKey)
      .activeTask.pendingFollowUp.clarification).toMatch(/Which call/);
    expect(h.writes()).toEqual([]);
    await h.send('NEW-CALL');
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
  });

  it('a delivered clarification expires 30 seconds after output regardless of prior turns', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    await h.send('Central, put me on that call');
    const pending = speaker(h);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(Date.now()).toBeGreaterThan(pending.expiresAt);
    expect(await h.send('OLD-CALL')).toBe(false);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
  });

  it('an explicitly addressed fresh request supersedes a pending reply instead of hijacking it', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    await h.send('Central, put me on that call');
    expect(speaker(h)?.promptState).toBe('delivered');
    await h.send('Central, mark me available');
    expect(speaker(h)).toBeUndefined();
    expect(h.cad.units.find(u => u.unit_number === 'A1').status).toBe('available');
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
  });

  it('rejects the actual AI transmitter identity as incoming radio traffic', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    await h.send('Central, put me on that call');
    const pending = speaker(h);
    expect(await h.runtime.handlePttStart(h.context.roomKey, h.runtime.identity, false, null)).toBe(false);
    expect(await h.runtime.handlePttEnd(h.context.roomKey, h.runtime.identity, false, null)).toBe(false);
    expect(speaker(h)).toBe(pending);
    expect(h.llm).toHaveBeenCalledTimes(1);
    await h.send('OLD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
  });

  it('a disposition answer is accepted after the dispatcher question actually finishes', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    const pending = speaker(h);
    expect(pending).toMatchObject({ kind: 'disposition', promptState: 'delivered' });
    expect(h.runtime.conversations.conversations.get(pending.sessionKey)
      .activeTask.pendingFollowUp.callId).toBe('OLD-CALL');
    await h.send('report taken');
    expect(h.writes('/api/radio/dispose').length).toBeGreaterThan(0);
    expect(h.cad.current.get('A1')).toBeNull();
  });

  it('two identical callsigns in separate centers have independent delivered prompts', async () => {
    const first = await make({ center: 'center-a', llmPlans: [assign(), answer('OLD-CALL')] });
    const second = await make({ center: 'center-b', llmPlans: [assign(), answer('NEW-CALL')] });
    await first.send('Central, put me on that call');
    await second.send('Central, put me on that call');
    const a = speaker(first), b = speaker(second);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a.sessionKey).not.toBe(b.sessionKey);
    await first.send('OLD-CALL');
    expect(first.cad.current.get('A1')).toBe('OLD-CALL');
    expect(speaker(second)).toBe(b);
    await second.send('NEW-CALL');
    expect(second.cad.current.get('A1')).toBe('NEW-CALL');
  });
});
