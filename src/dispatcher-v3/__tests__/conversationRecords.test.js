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

import { createHarness, finish, START_TIME } from './helpers/auditRuntimeHarness.js';

let harnesses;
let networkGuard;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-model-no-network');
  networkGuard = vi.fn(() => { throw new Error('External network is prohibited in 02-01 tests'); });
  vi.stubGlobal('fetch', networkGuard);
  harnesses = [];
});
afterEach(async () => {
  try {
    for (const h of harnesses) await h.close();
    expect(networkGuard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
async function make(options = {}) {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}
function plannerEnvelope(h, index = -1) {
  return h.runtime.planner.plan.mock.calls.at(index)[0].turnEnvelope;
}

describe('AI-DISP-V3-001 02-01 unit-owned conversations through real V3 runtime', () => {
  it('A1 retains its own traffic-stop dialogue after B2 and C3 speak, never theirs', async () => {
    const h = await make();
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, what is my current call?', 'A1');
    const first = plannerEnvelope(h);
    await h.send('Central, mark me available', 'B2');
    const other = plannerEnvelope(h);
    await h.send('Central, mark me available', 'C3');
    await h.send('Central, provide an update on my current call', 'A1');
    const last = h.runtime.planner.plan.mock.calls.at(-1)[0];
    const record = h.runtime.conversations.get(last.turnEnvelope);
    expect(record.id).toBe(h.runtime.conversations.get(first).id);
    expect(record.speakerUnitId).toBe('center-a-A1');
    expect(record.turns).toHaveLength(2);
    expect(record.turns.map((turn) => turn.speakerRef)).toEqual(['A1', 'A1']);
    expect(last.recentContext).toHaveLength(1);
    expect(last.recentContext[0].transcript).toContain('current call');
    expect(last.recentContext.some((item) => /B2|C3/.test(item.transcript))).toBe(false);
    expect(h.runtime.conversations.get(other).turns.every((turn) => turn.speakerRef === 'B2')).toBe(true);
    expect(h.runtime.conversations.activateTask(first, h.runtime.conversations.get(other).activeTask.id)).toBeNull();
  });

  it('records trusted speaker, capture timestamps, channel routing, conversation ID and task ID', async () => {
    const h = await make();
    const capture = await h.capture('A1');
    h.frame(capture);
    await vi.advanceTimersByTimeAsync(17);
    await finish(h.end(capture, 'Central, mark me available'));
    await h.flushOutput();
    const envelope = plannerEnvelope(h);
    const record = h.runtime.conversations.get(envelope);
    expect(record).toMatchObject({
      dispatchCenterId: envelope.dispatchCenterId,
      speakerUnitId: envelope.speaker.unitId, speakerRef: envelope.speakerRef,
      accountId: envelope.accountId, connectionId: envelope.connectionId,
      turns: [{ turnId: envelope.turnId, speakerRef: 'A1',
        channelId: envelope.channelId, roomKey: envelope.roomKey,
        captureStartedAt: envelope.captureStartedAt, captureEndedAt: envelope.captureEndedAt }],
    });
    expect(record.id).toEqual(expect.any(String));
    expect(record.activeTask.id).toEqual(expect.any(String));
    expect(record.activeTask.originalTurnId).toBe(envelope.turnId);
    expect(record.turns[0].conversationId).toBe(record.id);
    expect(record.turns[0].taskId).toBe(record.activeTask.id);
    expect(record.turns[0].capturedSequence).toBe(envelope.intakeSequence);
    expect(record.turns[0].captureEndedAt - record.turns[0].captureStartedAt).toBe(17);
  });

  it('bounds suspended topics and resumes an owned task without taking another unit task', async () => {
    const h = await make();
    await h.send('Central, mark me available', 'A1');
    const envelope = plannerEnvelope(h);
    const firstId = h.runtime.conversations.get(envelope).activeTask.id;
    for (let i = 0; i < 5; i++) await h.send('Central, mark me on scene', 'A1');
    const bounded = h.runtime.conversations.get(envelope);
    expect(bounded.suspendedTasks).toHaveLength(3);
    expect(bounded.turns.length).toBeLessThanOrEqual(12);
    expect(bounded.suspendedTasks.every((task) => task.state === 'suspended')).toBe(true);
    expect(h.runtime.conversations.activateTask(envelope, firstId)).toBeNull(); // oldest evicted
    const savedId = bounded.suspendedTasks[1].id;
    expect(h.runtime.conversations.activateTask(envelope, savedId)).toMatchObject({ id: savedId, state: 'active' });
    expect(h.runtime.conversations.get(envelope).activeTask.id).toBe(savedId);
    const c = await h.principal('B2');
    expect(c.unitId).toBe('B2');
    await h.send('Central, mark me available', 'B2');
    const bTaskId = h.runtime.conversations.get(plannerEnvelope(h)).activeTask.id;
    expect(h.runtime.conversations.activateTask(envelope, bTaskId)).toBeNull();
  });

  it('does not inherit an unfinished clarification across authenticated connections', async () => {
    const h = await make({ llmPlans: [{ action: 'CLARIFY', input: {}, confidence: 1, clarification: 'Which incident?' }] });
    await h.send('Central, please explain the assignment I mentioned earlier', 'A1');
    const first = plannerEnvelope(h);
    const pending = h.runtime.conversationGate.pendingFor('A1');
    expect(pending).toMatchObject({ clarification: 'Which incident?' });
    expect(pending.sessionKey).toBe(h.runtime.conversations.scopeKey(first));
    const callsBefore = h.runtime.planner.plan.mock.calls.length;
    const newPrincipal = await h.principal('A1', { connectionId: 'second-authenticated-socket' });
    const other = await h.capture('A1', { principal: newPrincipal });
    h.frame(other);
    expect(await finish(h.end(other, 'the red vehicle'))).toBe(false);
    expect(h.runtime.planner.plan.mock.calls).toHaveLength(callsBefore);
    const otherEnvelope = h.runtime.speech.endTransmission.mock.calls.at(-1)[0].turnEnvelope;
    expect(h.runtime.conversations.get(otherEnvelope)).toBeNull();
    expect(h.runtime.conversations.scopeKey(otherEnvelope)).not.toBe(h.runtime.conversations.scopeKey(first));
    expect(h.runtime.conversationGate.pendingFor('A1')).toBe(pending);
    expect(await h.send('the actual alarm', 'A1')).toBe(true);
  });

  it('isolates identical A1 callsigns in different dispatch centers', async () => {
    const first = await make({ center: 'center-a' });
    const second = await make({ center: 'center-b' });
    await first.send('Central, mark me available', 'A1');
    await second.send('Central, mark me en route', 'A1');
    const a = plannerEnvelope(first);
    const b = plannerEnvelope(second);
    expect(first.runtime.conversations.get(a).dispatchCenterId).toBe('center-a');
    expect(second.runtime.conversations.get(b).dispatchCenterId).toBe('center-b');
    expect(first.runtime.conversations.scopeKey(a)).not.toBe(second.runtime.conversations.scopeKey(b));
    expect(() => first.runtime.conversations.get(b)).toThrow();
    expect(() => second.runtime.conversations.get(a)).toThrow();
    expect(second.runtime.planner.plan.mock.calls[0][0].recentContext).toEqual([]);
  });

  it('expires conversational relevance without modifying any durable CAD record', async () => {
    const h = await make();
    await h.send('Central, what is my current call?', 'A1');
    const envelope = plannerEnvelope(h);
    expect(h.runtime.conversations.get(envelope)).not.toBeNull();
    const callsBefore = structuredClone([...h.cad.calls.entries()]);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(h.runtime.conversations.get(envelope)).toBeNull();
    expect(h.runtime.conversations.recent(envelope)).toEqual([]);
    expect([...h.cad.calls.entries()]).toEqual(callsBefore);
  });

  it('expires individual old turns even while the same unit keeps a conversation active', async () => {
    const h = await make();
    await h.send('Central, mark me available', 'A1');
    const first = plannerEnvelope(h);
    const conversationId = h.runtime.conversations.get(first).id;
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    await h.send('Central, mark me on scene', 'A1');
    const second = plannerEnvelope(h);
    expect(h.runtime.conversations.get(second).turns).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    const current = h.runtime.conversations.get(second);
    expect(current.id).toBe(conversationId);
    expect(current.turns).toHaveLength(1);
    expect(current.turns[0].turnId).toBe(second.turnId);
    expect(h.runtime.conversations.recent(second)).toHaveLength(1);
    expect(h.runtime.conversations.recent(second)[0].action).toBe('SET_UNIT_STATUS');
  });

  it('rejects fabricated envelopes and does not expose mutable authoritative records', async () => {
    const h = await make();
    await h.send('Central, mark me available', 'A1');
    const envelope = plannerEnvelope(h);
    expect(() => h.runtime.conversations.recordTurn({ ...envelope, speakerRef: 'B2' }, { transcript: 'spoof' })).toThrow();
    const record = h.runtime.conversations.get(envelope);
    record.turns[0].transcript = 'changed locally';
    record.activeTask.id = 'forged-task';
    expect(h.runtime.conversations.get(envelope).turns[0].transcript).not.toBe('changed locally');
    expect(h.runtime.conversations.get(envelope).activeTask.id).not.toBe('forged-task');
    expect(h.runtime.conversations.get(envelope).turns[0]).not.toHaveProperty('currentCall');
    expect(h.runtime.conversations.get(envelope).turns[0]).not.toHaveProperty('activeCalls');
  });

  it('does not expose new runtime conversations to stale-generation envelopes', async () => {
    const h = await make();
    await h.send('Central, mark me available', 'A1');
    const stale = plannerEnvelope(h);
    await h.runtime.stop();
    await h.runtime.start();
    await h.send('Central, mark me en route', 'A1');
    const current = plannerEnvelope(h);
    expect(current.runtimeGeneration).not.toBe(stale.runtimeGeneration);
    expect(h.runtime.conversations.get(current).turns).toHaveLength(1);
    expect(() => h.runtime.conversations.get(stale)).toThrow(/stale dispatcher generation/);
  });

  it('clears conversational state on runtime stop, without changing CAD state', async () => {
    const h = await make();
    await h.send('Central, mark me available', 'A1');
    const envelope = plannerEnvelope(h);
    expect(h.runtime.conversations.get(envelope)).toBeTruthy();
    await h.runtime.stop();
    expect(h.runtime.conversations.conversations.size).toBe(0);
    expect(h.cad.units.find((unit) => unit.unit_number === 'A1').status).toBe('available');
  });
});
