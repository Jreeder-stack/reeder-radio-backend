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

import { createHarness, START_TIME } from './helpers/auditRuntimeHarness.js';

let harnesses;
let networkGuard;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-model-no-network');
  networkGuard = vi.fn(() => { throw new Error('External network prohibited in 02-02'); });
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
const initial = () => ({ action: 'ASSIGN_UNIT', input: { unitRef: 'A1', callRef: 'that call' }, confidence: 1 });
const answer = (callId) => ({ action: 'ASSIGN_UNIT', input: { callId }, confidence: 1 });
const gatePending = (h) => h.runtime.conversationGate.pendingFor('A1');
const ownedTask = (h) => h.runtime.conversations.get(firstEnvelope(h))?.activeTask?.pendingTask;
const firstEnvelope = (h) => h.runtime.planner.plan.mock.calls[0][0].turnEnvelope;

describe('AI-DISP-V3-001 02-02 retained clarification tasks, actual V3 runtime', () => {
  it('R12: keeps the original assignment, complete known fields, call relationship, candidates and origin', async () => {
    const h = await make({ llmPlans: [initial()] });
    await h.send('Central, put me on that call');
    const pending = gatePending(h);
    const turn = firstEnvelope(h);
    const record = h.runtime.conversations.get(turn);
    expect(h.spoken().at(-1)).toBe('A1, which call?');
    expect(h.writes('/api/radio/assign')).toEqual([]);
    expect(pending).toMatchObject({
      kind: 'task_clarification', taskId: record.activeTask.id,
      promptTurnId: turn.turnId, sessionKey: h.runtime.conversations.scopeKey(turn),
    });
    expect(pending).not.toHaveProperty('pendingTask');
    expect(record.activeTask.pendingTask).toMatchObject({
      action: 'ASSIGN_UNIT', input: { unitRef: 'A1', callRef: 'that call' },
      unresolvedField: 'callId', originalTurnId: turn.turnId,
      candidateIds: ['OLD-CALL', 'NEW-CALL'],
      callRelationship: { speakerUnitId: turn.speaker.unitId, requestedCallRef: 'that call' },
    });
    expect(record.activeTask).toMatchObject({
      state: 'awaiting_clarification', action: 'ASSIGN_UNIT',
      requestedInput: { unitRef: 'A1', callRef: 'that call' },
    });
    expect(record.turns[0].action).toBe('CLARIFY'); // Spoken question, not task action.
    expect(record.activeTask.pendingTask).not.toHaveProperty('permissionGrants');
  });

  it('resumes and verifies the original assignment from a call-only answer, not a reconstructed command', async () => {
    const h = await make({ llmPlans: [initial(), answer('OLD-CALL')] });
    await h.send('Central, put me on that call');
    const pending = gatePending(h);
    await h.send('OLD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
    expect(h.writes('/api/radio/assign')[0].body).toMatchObject({ call_id: 'OLD-CALL', unit_id: 'A1' });
    const executed = h.runtime.executor.execute.mock.calls.at(-1)[0];
    expect(executed).toMatchObject({ action: 'ASSIGN_UNIT', input: { callId: 'OLD-CALL', unitId: 'center-a-A1' } });
    const result = await h.lastResult();
    expect(result).toMatchObject({ success: true, data: { verified: true } });
    expect(h.cad.current.get('A1')).toBe('OLD-CALL');
    expect(Boolean(h.runtime.conversationGate.pendingFor('A1'))).toBe(false);
    const record = h.runtime.conversations.get(firstEnvelope(h));
    expect(record.activeTask.originalTurnId).toBe(pending.promptTurnId);
    expect(record.activeTask.pendingTask).toBeNull();
    expect(record.activeTask.lastOutcome).toBe('completed_operation');
    const payload = JSON.parse(h.llm.mock.calls[1][0].messages[1].content);
    expect(payload.pendingContext).toMatchObject({
      kind: 'task_clarification', intendedAction: 'ASSIGN_UNIT',
      resolvedInput: { unitRef: 'A1', callRef: 'that call' },
      unresolvedField: 'callId', originalTurnId: pending.promptTurnId,
      candidateIds: ['OLD-CALL', 'NEW-CALL'],
    });
  });

  it('resolves a natural candidate description from current CAD instead of trusting a generated ID', async () => {
    const h = await make({ llmPlans: [initial(), { action: 'ASSIGN_UNIT', input: { callRef: 'Walmart' }, confidence: 1 }] });
    await h.send('Central, put me on that call');
    await h.send('the Walmart alarm');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
    expect(h.writes('/api/radio/assign')[0].body.call_id).toBe('OLD-CALL');
  });

  it('preserves the original requested unit and other constraints even if the follow-up model changes them', async () => {
    const h = await make({ llmPlans: [
      { action: 'ASSIGN_UNIT', input: { unitRef: 'B2', callRef: 'that call' }, confidence: 1 },
      { action: 'ASSIGN_UNIT', input: { unitRef: 'C3', callId: 'NEW-CALL', note: 'model-injected note' }, confidence: 1 },
    ] });
    await h.send('Central, put B2 on that call');
    await h.send('NEW-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
    expect(h.writes('/api/radio/assign')[0].body).toMatchObject({ unit_id: 'B2', call_id: 'NEW-CALL' });
    expect(h.cad.current.get('B2')).toBe('NEW-CALL');
    expect(h.cad.current.get('C3')).toBeNull();
    expect(h.runtime.executor.execute.mock.calls.at(-1)[0].input).not.toHaveProperty('note');
  });

  it('accepts a planner-originated complete CLARIFY task, retains it, then resumes safely', async () => {
    const h = await make({ llmPlans: [
      {
        action: 'CLARIFY', input: {}, confidence: 1, clarification: 'Which incident?',
        pendingTask: { action: 'ASSIGN_UNIT', input: { unitRef: 'A1', callRef: 'that call' },
          unresolvedField: 'callId', candidateIds: ['OLD-CALL', 'NEW-CALL'] },
      },
      answer('NEW-CALL'),
    ] });
    await h.send('Central, assign me to the incident you mentioned');
    expect(ownedTask(h)).toMatchObject({ action: 'ASSIGN_UNIT', unresolvedField: 'callId' });
    await h.send('NEW-CALL');
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
  });

  it('rejects an invented call outside the original candidate set, without writing or replacing the original task', async () => {
    const h = await make({ llmPlans: [initial(), answer('THIRD-CALL'), answer('OLD-CALL')] });
    await h.send('Central, put me on that call');
    const other = { ...h.cad.calls.get('OLD-CALL'), id: 'THIRD-CALL', call_id: 'THIRD-CALL', call_number: 'THIRD-CALL' };
    h.cad.calls.set('THIRD-CALL', other);
    const task = ownedTask(h);
    await h.send('THIRD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(ownedTask(h)).toEqual(task);
    expect(h.spoken().at(-1)).toContain('not among the original candidates');
    await h.send('OLD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
  });

  it('rejects a closed or removed call candidate during the answer turn', async () => {
    const h = await make({ llmPlans: [initial(), answer('OLD-CALL')] });
    await h.send('Central, put me on that call');
    h.cad.calls.get('OLD-CALL').status = 'closed';
    await h.send('OLD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(ownedTask(h).action).toBe('ASSIGN_UNIT');
    expect(h.spoken().at(-1)).toContain('no longer active');
  });

  it('requires the same prior call relationship for resuming an assignment task', async () => {
    const h = await make({ llmPlans: [initial(), answer('OLD-CALL')] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, put me on that call');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('OLD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(ownedTask(h).callRelationship.currentCallIdAtRequest).toBe('OLD-CALL');
  });

  it('does not allow another unit or authenticated connection to answer the pending task', async () => {
    const h = await make({ llmPlans: [initial()] });
    await h.send('Central, put me on that call');
    const original = gatePending(h);
    const otherUnit = await h.capture('B2');
    h.frame(otherUnit);
    const otherEnd = h.end(otherUnit, 'OLD-CALL');
    // Turn completion is driven by the actual PTT lifecycle.
    const { finish } = await import('./helpers/auditRuntimeHarness.js');
    expect(await finish(otherEnd)).toBe(false);
    const principal = await h.principal('A1', { connectionId: 'other-authenticated-socket' });
    const otherSession = await h.capture('A1', { principal });
    h.frame(otherSession);
    expect(await finish(h.end(otherSession, 'OLD-CALL'))).toBe(false);
    expect(gatePending(h)).toBe(original);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
  });

  it('expires a pending answer instead of executing stale words', async () => {
    const h = await make({ llmPlans: [initial()] });
    await h.send('Central, put me on that call');
    await vi.advanceTimersByTimeAsync(31000);
    expect(await h.send('OLD-CALL')).toBe(false);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
  });

  it('a new explicit addressed command is independent of the held assignment', async () => {
    const h = await make({ llmPlans: [initial()] });
    await h.send('Central, put me on that call');
    await h.send('Central, mark me available');
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(h.cad.units[0].status).toBe('available');
    expect(Boolean(h.runtime.conversationGate.pendingFor('A1'))).toBe(false);
  });

  it('does not create an executable task from generic CLARIFY without a known intended action', async () => {
    const h = await make({ llmPlans: [{ action: 'CLARIFY', input: {}, confidence: 1, clarification: 'Which request?' }] });
    await h.send('Central, please clarify an earlier request');
    const record = h.runtime.conversations.get(firstEnvelope(h));
    expect(gatePending(h).kind).not.toBe('task_clarification');
    expect(record.activeTask.pendingTask).toBeNull();
    expect(h.writes()).toEqual([]);
  });

  it('rejects model-proposed physical emergency action inside clarification, without triggering hardware', async () => {
    const h = await make({ llmPlans: [{
      action: 'CLARIFY', clarification: 'What location?', confidence: 1,
      pendingTask: { action: 'DECLARE_EMERGENCY', input: { unitRef: 'A1' }, unresolvedField: 'location' },
    }] });
    await h.send('Central, clarify the incident location');
    expect(gatePending(h).kind).not.toBe('task_clarification');
    expect(h.runtime._emergency).toBeNull();
    expect(h.writes()).toEqual([]);
  });
});
