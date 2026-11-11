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

import { assertV3CurrentTaskCall } from '../operationalContext.js';
import { DispatcherV3Error, V3_ERROR_CODES } from '../errors.js';
import { createHarness, START_TIME } from './helpers/auditRuntimeHarness.js';

let harnesses, networkGuard;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-no-network');
  networkGuard = vi.fn(() => { throw new Error('External network prohibited in 02-05'); });
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
const report = (unitRef = 'A1') => ({ action: 'REPORT_FIELD_INCIDENT', confidence: 1,
  input: { unitRef, eventType: 'officer_assist', note: 'Subject moving away' } });
const update = (informationType = 'subject_description', value = 'blue jacket') => ({
  action: 'UPDATE_FIELD_INCIDENT', confidence: 1, input: { unitRef: 'A1', informationType, value },
});
const lastPending = (h) => h.runtime.conversationGate.pendingFor('A1');
const originalEnvelope = (h) => h.runtime.planner.plan.mock.calls[0][0].turnEnvelope;
const context = ({ current = 'OLD-CALL', listed = true, unit = 'center-a-A1', status = 'active' } = {}) => ({
  speaker: { unitId: unit }, currentCall: current ? { id: current, status } : null,
  activeCalls: listed ? [{ id: 'OLD-CALL', status }] : [],
});

describe('AI-DISP-V3-001 02-05 fresh CAD relationship validation', () => {
  it('requires current unit, target and center-scoped active call to agree', () => {
    expect(assertV3CurrentTaskCall({ operationalContext: context(), expectedCallId: 'OLD-CALL',
      expectedUnitId: 'center-a-A1' })).toEqual({ currentCallId: 'OLD-CALL', active: true });
  });
  it.each([
    [{ current: 'NEW-CALL' }, 'reassigned'],
    [{ current: null }, 'unassigned'],
    [{ current: 'OLD-CALL', listed: false }, 'target_not_active'],
    [{ status: 'closed' }, 'target_not_active'],
    [{ status: 'canceled' }, 'target_not_active'],
    [{ unit: 'center-a-B2' }, 'speaker_identity_changed'],
  ])('fails closed for changed/closed assignment %#', (shape, reason) => {
    try {
      assertV3CurrentTaskCall({ operationalContext: context(shape), expectedCallId: 'OLD-CALL',
        expectedUnitId: 'center-a-A1' });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
        details: { reason } });
    }
  });
  it('allows an originally unassigned incident only while the unit remains unassigned', () => {
    expect(assertV3CurrentTaskCall({ operationalContext: context({ current: null }),
      expectedCallId: null, expectedUnitId: 'center-a-A1', allowUnassigned: true })).toMatchObject({ active: true });
    expect(() => assertV3CurrentTaskCall({ operationalContext: context({ current: 'NEW-CALL' }),
      expectedCallId: null, allowUnassigned: true })).toThrow();
  });
  it('does not interpret absent or unreachable CAD data as permission', () => {
    expect(() => assertV3CurrentTaskCall({ operationalContext: null,
      expectedCallId: 'OLD-CALL' })).toThrowError(/could not be verified/);
    expect(() => assertV3CurrentTaskCall({ operationalContext: { speaker: { unitId: 'A1' } },
      expectedCallId: 'OLD-CALL' })).toThrowError(/could not be verified/);
  });
});

describe('AI-DISP-V3-001 02-05 real V3 PTT, task and CAD path', () => {
  it('rejects a delivered disposition answer after a different dispatcher reassigns A1', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    expect(lastPending(h)).toMatchObject({ kind: 'disposition', promptState: 'delivered' });
    expect(h.runtime.conversations.get(originalEnvelope(h)).activeTask.pendingFollowUp.callId).toBe('OLD-CALL');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('report taken');
    expect(h.writes('/api/radio/dispose')).toEqual([]);
    expect(h.writes('/api/radio/clear')).toEqual([]);
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(lastPending(h)).toBeUndefined();
    expect(h.spoken().at(-1)).toMatch(/no longer matches|earlier call|assignment/i);
    expect(h.runtime.conversations.get(originalEnvelope(h)).activeTask.state).toBe('canceled');
  });

  it('does not dispose a closed call even if a stale current-call endpoint still names it', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    h.cad.calls.get('OLD-CALL').status = 'closed';
    await h.send('report taken');
    expect(h.writes('/api/radio/dispose')).toEqual([]);
    expect(lastPending(h)).toBeUndefined();
    expect(h.spoken().at(-1)).toContain('no longer active');
  });

  it('allows the original still-current disposition and verified CAD completion', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    await h.send('report taken');
    expect(h.writes('/api/radio/dispose')).toHaveLength(1);
    expect(h.cad.current.get('A1')).toBeNull();
  });

  it('pins model disposition without a call ID to the saved target, then rejects reassignment', async () => {
    const h = await make({ llmPlans: [{ action: 'CLEAR_UNIT', confidence: 1,
      input: { unitRef: 'A1', disposition: 'warning issued' } }] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('warning issued and the report is complete');
    expect(h.writes('/api/radio/dispose')).toEqual([]);
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
  });

  it('refuses a model answer attempting to redirect an old disposition to another call', async () => {
    const h = await make({ llmPlans: [{ action: 'CLEAR_UNIT', confidence: 1,
      input: { unitRef: 'A1', callId: 'NEW-CALL', disposition: 'report' } }] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    await h.send('that other call is a report');
    expect(h.writes('/api/radio/dispose')).toEqual([]);
    expect(h.writes('/api/radio/clear')).toEqual([]);
    expect(lastPending(h)).toBeUndefined();
  });

  it('rechecks disposition immediately before CAD submission after the handler reads call details', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    const get = h.runtime.gateway.get.bind(h.runtime.gateway);
    vi.spyOn(h.runtime.gateway, 'get').mockImplementation(async (path, args) => {
      const result = await get(path, args);
      if (path === '/api/radio/call/OLD-CALL') h.cad.current.set('A1', 'NEW-CALL');
      return result;
    });
    await h.send('report taken');
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(h.writes('/api/radio/dispose')).toEqual([]);
    expect(lastPending(h)).toBeUndefined();
  });

  it('R05 continuation: reassignment prevents a subject detail on the old incident', async () => {
    const h = await make({ llmPlans: [report(), update()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('blue jacket');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.cad.calls.get('OLD-CALL').call_notes).toHaveLength(1);
    expect(h.cad.calls.get('NEW-CALL').call_notes).toHaveLength(0);
    expect(lastPending(h)).toBeUndefined();
    expect(h.runtime.fieldIncidents.getDialogueContext('A1')).toBeNull();
  });

  it('does not write follow-up incident notes after a call is closed by another actor', async () => {
    const h = await make({ llmPlans: [report(), update()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    h.cad.calls.get('OLD-CALL').status = 'closed';
    await h.send('blue jacket');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.spoken().at(-1)).toContain('no longer active');
  });

  it('late reassignment after semantic planning is checked before any incident note write', async () => {
    const h = await make({ llmPlans: [report()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    const originalPlan = h.runtime.planner.plan.bind(h.runtime.planner);
    vi.spyOn(h.runtime.planner, 'plan').mockImplementationOnce(async (args) => {
      const result = await originalPlan({ ...args, transcript: 'blue jacket' });
      h.cad.current.set('A1', 'NEW-CALL');
      return { ...result, ...update() };
    });
    await h.send('blue jacket');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
  });

  it('revalidates again after asynchronous location resolution, before UPDATE_CALL or note', async () => {
    const h = await make({ llmPlans: [report(), update('location', 'old fairgrounds')] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    const get = h.runtime.gateway.get.bind(h.runtime.gateway);
    vi.spyOn(h.runtime.gateway, 'get').mockImplementation(async (path, args) => {
      const response = await get(path, args);
      if (path === '/api/radio/locations/resolve') h.cad.current.set('A1', 'NEW-CALL');
      return response;
    });
    await h.send('old fairgrounds');
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.writes().filter((req) => req.method === 'PATCH')).toEqual([]);
    expect(lastPending(h)).toBeUndefined();
  });

  it('rechecks a field note immediately at the CAD write boundary after another actor updates assignment', async () => {
    const h = await make({ llmPlans: [report(), update()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    const realNote = h.runtime.fieldIncidents.addCallNote;
    h.runtime.fieldIncidents.addCallNote = async (args) => {
      h.cad.current.set('A1', 'NEW-CALL');
      return realNote(args);
    };
    await h.send('blue jacket');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(lastPending(h)).toBeUndefined();
  });

  it('rechecks after the CAD handler\'s second asynchronous address resolution before PATCH', async () => {
    const h = await make({ llmPlans: [report(), update('location', 'old fairgrounds')] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    const get = h.runtime.gateway.get.bind(h.runtime.gateway);
    let locations = 0;
    vi.spyOn(h.runtime.gateway, 'get').mockImplementation(async (path, args) => {
      const response = await get(path, args);
      if (path === '/api/radio/locations/resolve' && ++locations === 2) {
        h.cad.current.set('A1', 'NEW-CALL');
      }
      return response;
    });
    await h.send('old fairgrounds');
    expect(locations).toBeGreaterThanOrEqual(2);
    expect(h.writes().filter((entry) => entry.method === 'PATCH')).toEqual([]);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(lastPending(h)).toBeUndefined();
  });

  it('records a valid same-call field follow-up and keeps its outstanding goals', async () => {
    const h = await make({ llmPlans: [report(), update()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    await h.send('blue jacket');
    expect(h.writes('/api/radio/note')).toHaveLength(2);
    expect(h.cad.calls.get('OLD-CALL').call_notes).toHaveLength(2);
    expect(h.runtime.fieldIncidents.getDialogueContext('A1')?.pendingGoals).toContain('location');
  });

  it('allows an explicitly referenced prior active call via ordinary authorized CAD note path', async () => {
    const h = await make({ llmPlans: [{ action: 'ADD_CALL_NOTE', confidence: 1,
      input: { callId: 'OLD-CALL', note: 'Supplemental witness statement', unitRef: 'A1' } }] });
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, add a supplemental witness statement to OLD-CALL');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.cad.calls.get('OLD-CALL').call_notes).toHaveLength(1);
    expect(h.cad.calls.get('NEW-CALL').call_notes).toHaveLength(0);
  });

  it('a read-only unit cannot use the historical-call exception to add notes', async () => {
    const h = await make({ scopes: ['call.read','unit.read'], llmPlans: [{ action: 'ADD_CALL_NOTE', confidence: 1,
      input: { callId: 'OLD-CALL', note: 'Unauthorized note' } }] });
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, add a note to OLD-CALL');
    expect(h.writes('/api/radio/note')).toEqual([]);
  });

  it('NO_ACTION and unrelated speech never become a field incident note or revive a follow-up', async () => {
    const h = await make({ llmPlans: [report(), { action: 'NO_ACTION', confidence: 1, input: {} }] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    await h.send('that is not a new fact');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(lastPending(h)).toBeUndefined();
    expect(h.runtime.fieldIncidents.getDialogueContext('A1')).toBeNull();
    expect(await h.send('blue shirt')).toBe(false);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('an unrelated complete command in a delivered incident window executes independently, not as an old-call note', async () => {
    const h = await make({ llmPlans: [report()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    await h.send('mark me available');
    expect(h.writes('/api/radio/status').map((entry) => entry.body.status)).toEqual(['available']);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(lastPending(h)).toBeUndefined();
  });

  it('a new addressed topic does not inherit the original field report or old call', async () => {
    const h = await make({ llmPlans: [report(), { action: 'NO_ACTION', confidence: 1, input: {} }] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, what did the witness say yesterday?');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('a call changed before resume is invalidated rather than re-asking the stale disposition', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, clear me from my call');
    await h.send('Central, new topic: radio check');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, resume my earlier disposition');
    expect(lastPending(h)).toBeUndefined();
    expect(h.spoken().at(-1)).toMatch(/assignment|earlier call/);
    expect(h.writes('/api/radio/dispose')).toEqual([]);
  });

  it('a closed incident cannot be resumed after a topic change', async () => {
    const h = await make({ llmPlans: [report()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    await h.send('Central, new topic: radio check');
    h.cad.calls.get('OLD-CALL').status = 'closed';
    await h.send('Central, resume my earlier report');
    expect(lastPending(h)).toBeUndefined();
    expect(h.writes('/api/radio/note')).toHaveLength(1);
  });

  it('transient CAD lookup failures suspend the original task without performing a write', async () => {
    const h = await make({ llmPlans: [report(), update()] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this incident');
    const snap = h.runtime.operationalContextService.snapshot.bind(h.runtime.operationalContextService);
    let reads = 0;
    const spy = vi.spyOn(h.runtime.operationalContextService, 'snapshot').mockImplementation(async (args) => {
      reads += 1;
      if (reads > 1) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, 'Synthetic CAD timeout');
      return snap(args);
    });
    await h.send('blue jacket');
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(lastPending(h)).toBeUndefined();
    expect(h.runtime.conversations.get(originalEnvelope(h)).suspendedTasks.some((task) => task.kind === 'field_incident')).toBe(true);
    spy.mockRestore();
    await h.send('Central, resume my earlier report');
    expect(lastPending(h)).toMatchObject({ kind: 'field_incident', promptState: 'delivered' });
  });

  it('same callsign in another center cannot acquire or alter a pending call relationship', async () => {
    const first = await make({ center: 'center-a', llmPlans: [report()] });
    const second = await make({ center: 'center-b', llmPlans: [report()] });
    first.cad.current.set('A1', 'OLD-CALL');
    second.cad.current.set('A1', 'NEW-CALL');
    await first.send('Central, document the incident');
    await second.send('Central, document the incident');
    first.cad.current.set('A1', null);
    await first.send('Central, disregard the previous request');
    expect(second.runtime.fieldIncidents.getDialogueContext('A1')).not.toBeNull();
    expect(first.writes('/api/radio/note')).toHaveLength(1);
    expect(second.writes('/api/radio/note')).toHaveLength(1);
  });

  it('a fresh field update with no known assignment fails closed rather than buffering unknown notes', async () => {
    const h = await make({ llmPlans: [update()] });
    await h.send('Central, add that subject detail');
    expect(h.writes('/api/radio/note')).toEqual([]);
    expect(h.runtime.fieldIncidents.getDialogueContext('A1')).toBeNull();
  });
});
