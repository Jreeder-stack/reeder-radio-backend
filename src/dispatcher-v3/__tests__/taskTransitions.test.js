import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT forbidden'); },
  textToSpeech: () => { throw new Error('Live TTS forbidden'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging forbidden'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model forbidden'); } } }));

import { classifyV3TaskTransition } from '../taskTransitions.js';
import { createHarness, finish, START_TIME } from './helpers/auditRuntimeHarness.js';

const incident = () => ({ action: 'REPORT_FIELD_INCIDENT', confidence: 1,
  input: { unitRef: 'A1', eventType: 'officer_assist', note: 'subject moving away' } });
const assign = () => ({ action: 'ASSIGN_UNIT', confidence: 1, input: { unitRef: 'A1', callRef: 'that call' } });
const answer = () => ({ action: 'ASSIGN_UNIT', confidence: 1, input: { callId: 'OLD-CALL' } });
let harnesses, networkGuard;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-no-network');
  networkGuard = vi.fn(() => { throw new Error('External network prohibited in 02-04'); });
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
const pending = (h, unit = 'A1') => h.runtime.conversationGate.pending.get(unit);
const original = (h) => h.runtime.planner.plan.mock.calls[0][0].turnEnvelope;

describe('AI-DISP-V3-001 02-04 task controls and real V3 runtime', () => {
  it('matches only complete control expressions; disposition and quotations are not cancellation', () => {
    expect(classifyV3TaskTransition('disregard the previous request')).toEqual({ kind: 'cancel' });
    expect(classifyV3TaskTransition('correction, mark me available')).toEqual({ kind: 'correct', revisedRequest: 'mark me available' });
    expect(classifyV3TaskTransition('new topic: radio check')).toEqual({ kind: 'topic', revisedRequest: 'radio check' });
    expect(classifyV3TaskTransition('resume my earlier report')).toEqual({ kind: 'resume', selector: 'report' });
    for (const text of ['cancelled by complainant', 'the witness said disregard that',
      'do not cancel the call', 'is that request canceled?', 'correct the address on my call']) {
      expect(classifyV3TaskTransition(text)).toBeNull();
    }
  });

  it('R05: cancellation never becomes an OLD-CALL incident note after A1 changes calls', async () => {
    const h = await make({ llmPlans: [incident()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document the field incident');
    const task = h.runtime.conversations.get(original(h)).activeTask;
    expect(task.kind).toBe('field_incident');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, disregard the previous request');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.runtime.fieldIncidents.getDialogueContext('A1')).toBeNull();
    expect(h.runtime.conversations.get(original(h)).activeTask.state).toBe('canceled');
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(h.spoken().at(-1)).toContain('not been reversed');
  });

  it('cancels retained clarification without writing, and late answers cannot execute', async () => {
    const h = await make({ llmPlans: [assign()] });
    await h.send('Central, put me on that call');
    expect(pending(h).kind).toBe('task_clarification');
    await h.send('Central, never mind');
    expect(pending(h)).toBeUndefined();
    expect(await h.send('OLD-CALL')).toBe(false);
    expect(h.writes('/api/radio/assign')).toEqual([]);
  });

  it('another unit cannot cancel or consume A1 pending task', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    await h.send('Central, put me on that call', 'A1');
    const held = pending(h);
    await h.send('Central, disregard that', 'B2');
    expect(pending(h)).toBe(held);
    await h.send('OLD-CALL', 'A1');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
  });

  it('another authenticated A1 connection cannot clear the prior connection', async () => {
    const h = await make({ llmPlans: [assign()] });
    await h.send('Central, put me on that call');
    const held = pending(h);
    const principal = await h.principal('A1', { connectionId: 'different-authenticated-socket' });
    const capture = await h.capture('A1', { principal });
    h.frame(capture);
    expect(await finish(h.end(capture, 'Central, disregard that'))).toBe(true);
    await h.flushOutput();
    expect(pending(h)).toBe(held);
    expect(h.writes('/api/radio/assign')).toEqual([]);
  });

  it('correction replaces pending command with a complete independently verified status action', async () => {
    const h = await make({ llmPlans: [assign()] });
    await h.send('Central, put me on that call');
    const old = h.runtime.conversations.get(original(h)).activeTask.id;
    await h.send('Central, correction, mark me available');
    expect(h.runtime.conversations.get(original(h)).activeTask.id).not.toBe(old);
    expect(h.writes('/api/radio/assign')).toEqual([]);
    expect(h.writes('/api/radio/status').map((entry) => entry.body.status)).toEqual(['available']);
    expect(pending(h)).toBeUndefined();
  });

  it('bare correction requires a new complete request and fresh delivered prompt', async () => {
    const h = await make({ llmPlans: [assign()] });
    await h.send('Central, put me on that call');
    await h.send('Central, correction');
    expect(pending(h)).toMatchObject({ kind: 'correction', promptState: 'delivered' });
    await h.send('mark me on scene');
    expect(h.writes('/api/radio/status').map((entry) => entry.body.status)).toEqual(['on_scene']);
    expect(h.writes('/api/radio/assign')).toEqual([]);
  });

  it('new topic suspends old field incident; status is not written as an old incident note', async () => {
    const h = await make({ llmPlans: [incident()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document the field incident');
    const old = h.runtime.conversations.get(original(h)).activeTask.id;
    await h.send('Central, new topic: mark me available');
    const record = h.runtime.conversations.get(original(h));
    expect(record.suspendedTasks.some((task) => task.id === old && task.kind === 'field_incident')).toBe(true);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('bare new topic and its answer use separate dialogue custody', async () => {
    const h = await make({ llmPlans: [incident()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document the field incident');
    await h.send('Central, new topic');
    expect(pending(h)).toMatchObject({ kind: 'new_topic', promptState: 'delivered' });
    await h.send('radio check');
    expect(h.spoken().at(-1)).toContain('loud and clear');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('resumes its own suspended incident by asking again, without replaying a CAD mutation', async () => {
    const h = await make({ llmPlans: [incident()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document the field incident');
    const old = h.runtime.conversations.get(original(h)).activeTask.id;
    await h.send('Central, new topic: radio check');
    await h.send('Central, resume my earlier report');
    expect(h.runtime.conversations.get(original(h)).activeTask.id).toBe(old);
    expect(pending(h)).toMatchObject({ kind: 'field_incident', promptState: 'delivered', taskId: old });
    expect(h.spoken().at(-1)).toMatch(/location/i);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('resumes the complete original assignment, and only a new delivered answer executes it', async () => {
    const h = await make({ llmPlans: [assign(), answer()] });
    await h.send('Central, put me on that call');
    const old = h.runtime.conversations.get(original(h)).activeTask.id;
    await h.send('Central, new topic: radio check');
    await h.send('Central, resume my earlier assignment');
    expect(pending(h)).toMatchObject({ kind: 'task_clarification', taskId: old, promptState: 'delivered' });
    await h.send('OLD-CALL');
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
  });

  it('resumes a disposition and does not confuse cancelled-by-complainant with conversation cancel', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    expect(pending(h).kind).toBe('disposition');
    await h.send('Central, new topic: radio check');
    await h.send('Central, resume my earlier disposition');
    expect(pending(h)).toMatchObject({ kind: 'disposition', callId: 'OLD-CALL', promptState: 'delivered' });
    await h.send('cancelled by complainant');
    expect(h.writes('/api/radio/dispose')).toHaveLength(1);
    expect(h.cad.current.get('A1')).toBeNull();
  });

  it('cannot resume canceled tasks or resurrect them with a late delivery receipt', async () => {
    const h = await make({ llmPlans: [assign()] });
    await h.send('Central, put me on that call');
    const earlier = pending(h);
    await h.send('Central, disregard that');
    expect(h.runtime.conversationGate.settlePromptDelivery({ ...earlier, unitId: 'A1', status: 'completed' })).toBe(false);
    await h.send('Central, resume my earlier assignment');
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
    expect(h.writes('/api/radio/assign')).toEqual([]);
  });

  it('bounded expiry removes suspended tasks and the original cannot be replayed', async () => {
    const h = await make({ llmPlans: [assign()] });
    await h.send('Central, put me on that call');
    await h.send('Central, new topic: radio check');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    await h.send('Central, resume my earlier assignment');
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
    expect(h.writes('/api/radio/assign')).toEqual([]);
  });

  it('B2 cannot resume A1 suspended incident on the same dispatch center', async () => {
    const h = await make({ llmPlans: [incident()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document the field incident', 'A1');
    await h.send('Central, new topic: radio check', 'A1');
    await h.send('Central, resume my earlier report', 'B2');
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('the semantic model can request a task cancel, not bypass CAD controls', async () => {
    const h = await make({ llmPlans: [assign(), { action: 'CANCEL_TASK', input: {}, confidence: 1 }] });
    await h.send('Central, put me on that call');
    await h.send('Central, withdraw my pending instruction');
    expect(h.writes('/api/radio/assign')).toEqual([]);
    expect(pending(h)).toBeUndefined();
  });
});
