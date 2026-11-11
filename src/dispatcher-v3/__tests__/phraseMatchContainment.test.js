import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real planner, PTT runtime, resolver, executor and read-back
// verification. Only external speech/model/CAD/radio boundaries are synthetic.
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited in containment tests'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited in containment tests'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model client prohibited'); } } }));

import { V3IntentPlanner } from '../intentPlanner.js';
import { NO_ACTION, START_TIME, createHarness, plan } from './helpers/auditRuntimeHarness.js';

let harnesses;
let networkGuard;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-model-no-network');
  networkGuard = vi.fn(() => { throw new Error('Unexpected external network request'); });
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

async function make(options) {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}

function semanticPlanner(reply = NO_ACTION) {
  const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  const planner = new V3IntentPlanner({ client: { chat: { completions: { create } } } });
  return { planner, create };
}

function modelPayload(create) {
  return JSON.parse(create.mock.calls.at(-1)[0].messages.find((message) => message.role === 'user').content);
}

function plannerRequest(transcript, units = [{ callsign: 'A1' }, { callsign: 'B2' }]) {
  return {
    transcript, speakerCallsign: 'A1', correlationId: 'containment-planner',
    runtimeContext: { runtimeId: 'containment', dispatchCenterId: 'center-a', roomKey: 'center-a__OPS1' },
    operationalContext: { units },
  };
}

describe('03-01 full-sentence meaning containment through the actual PTT runtime', () => {
  // These deliberately include more than negation: questions, reported speech,
  // past/future context, alternatives, trailing conditions and punctuation.
  it.each([
    'do not mark B2 available',
    "don't mark B2 available",
    'B2 is not on scene',
    'B2 is available',
    'B2 was on scene yesterday',
    'When B2 is available call me',
    'If B2 is available, send the details',
    'Did you hear B2 say available',
    'The caller said B2 was on scene',
    'Mark B2 available but only after the call closes',
    'Mark B2 available tomorrow',
    'Mark B2 available or busy',
    'Mark B2 and C3 available',
    'Mark B2 available and leave C3 on scene',
    'B2 available?',
    'Mark B2 available?',
    'available?',
    'show me available?',
    '"mark B2 available"',
    "I didn't say mark B2 available",
    'No shots fired',
    'Is B2 at gunpoint?',
    'Caller reports shots fired yesterday',
    'If there are shots fired, send backup',
    'I have nobody at gunpoint',
    "I'm not fighting with him",
    'officer down was the training scenario',
    'shots fired?',
    'markavailable',
    'showme available',
    'setbusy',
    'putin service',
  ])('does not invent a mutation from %s', async (transcript) => {
    const h = await make({ llmPlans: [NO_ACTION] });
    await h.send(`Central, ${transcript}`);
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect((await h.lastPlan()).action).toBe('NO_ACTION');
    expect(modelPayload(h.llm).transcript).toContain(transcript);
    expect(h.cad.units.every((unit) => unit.status === 'on_duty')).toBe(true);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  });

  it('executes a status question as a read, preserving the requested other unit', async () => {
    const h = await make({ llmPlans: [plan('STATUS_CHECK', { unitRef: 'B2' })] });
    await h.send('Central, is B2 available?');
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STATUS_CHECK', input: { unitId: 'center-a-B2' } }),
      expect.any(Object),
    );
    expect(await h.lastResult()).toMatchObject({ success: true, action: 'STATUS_CHECK' });
  });

  it.each([
    ['mark B2 available', 'B2', 'available'],
    ['put B2 not available', 'B2', 'not_available'],
    ['show B2 on scene', 'B2', 'on_scene'],
    ['set B2 out of service', 'B2', 'out_of_service'],
    ['show me available', 'A1', 'available'],
    ['on scene', 'A1', 'on_scene'],
    ["A1, I'm on scene", 'A1', 'on_scene'],
    ['A1, available.', 'A1', 'available'],
  ])('preserves an unambiguous positive command: %s', async (transcript, target, status) => {
    const h = await make();
    await h.send(`Central, ${transcript}`);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.writes('/api/radio/status')[0].body).toMatchObject({ unit_id: target, status });
    expect(await h.lastResult()).toMatchObject({ success: true, data: { verified: true } });
    expect(h.cad.units.find((unit) => unit.unit_number === target).status).toBe(status);
    const unaffected = target === 'A1' ? 'B2' : 'A1';
    expect(h.cad.units.find((unit) => unit.unit_number === unaffected).status).toBe('on_duty');
  });

  it('accepts a natural positive paraphrase through semantics and verifies the actual write', async () => {
    const h = await make({ llmPlans: [plan('SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' })] });
    await h.send('Central, please put B2 back into the pool of units ready for a call');
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/status').map((request) => request.body)).toEqual([{ unit_id: 'B2', status: 'available' }]);
    expect(await h.lastResult()).toMatchObject({ success: true, data: { verified: true } });
  });

  it('does not confuse a status word inside a callsign with the requested status', async () => {
    const h = await make();
    h.cad.units.push({ id: 'center-a-AVAILABLE-1', unit_number: 'AVAILABLE-1', unit_id: 'AVAILABLE-1', status: 'on_duty', agency_id: 'synthetic-agency' });
    await h.send('Central, show AVAILABLE-1 busy');
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.writes('/api/radio/status').map((request) => request.body)).toEqual([{ unit_id: 'AVAILABLE-1', status: 'busy' }]);
    expect(await h.lastResult()).toMatchObject({ success: true, data: { verified: true } });
  });
});

describe('03-01 removed open-slot shortcuts preserve legitimate semantic operations', () => {
  it('creates a call without inventing an assignment when the unit explicitly declines assignment', async () => {
    const h = await make({ llmPlans: [plan('CREATE_CALL', { type: 'BUILDING CHECK', location: '100 Main Street' })] });
    await h.send("Central, create a building check at 100 Main Street, don't assign anybody");
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/v3/cad/calls')).toHaveLength(1);
    expect(h.writes('/api/radio/v3/cad/calls')[0].body).toMatchObject({ location: '100 Main Street', units: [] });
    expect(h.writes('/api/radio/assign')).toEqual([]);
    expect(h.cad.current.get('A1')).toBeNull();
    expect(await h.lastResult()).toMatchObject({ success: true, data: { verified: true } });
  });

  it('preserves both parts of a compound request and keeps the trailing instruction out of the address', async () => {
    const h = await make({ llmPlans: [{ confidence: 1, actions: [
      { action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main Street', unitRefs: ['A1'] } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'on_scene' } },
    ] }] });
    await h.send('Central, start a building check at 100 Main Street and mark me on scene');
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes().map((request) => request.path)).toEqual(['/api/radio/v3/cad/calls', '/api/radio/status']);
    expect(h.writes('/api/radio/v3/cad/calls')[0].body).toMatchObject({ type: 'BUILDING CHECK', location: '100 Main Street', units: ['A1'] });
    expect(h.writes('/api/radio/status')[0].body).toMatchObject({ unit_id: 'A1', status: 'on_scene' });
    for (const result of h.runtime.executor.execute.mock.results) expect(await result.value).toMatchObject({ success: true, data: { verified: true } });
  });

  it('preserves named-call assignment followed by status through semantic interpretation', async () => {
    const h = await make({ llmPlans: [{ confidence: 1, actions: [
      { action: 'ASSIGN_UNIT', input: { callId: 'NEW-CALL', unitRef: 'A1' } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'en_route' } },
    ] }] });
    await h.send('Central, show me en route to the traffic stop at 200 Oak Street');
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes().map((request) => request.path)).toEqual(['/api/radio/assign', '/api/radio/status']);
    expect(h.cad.current.get('A1')).toBe('NEW-CALL');
    expect(h.writes('/api/radio/status')[0].body).toMatchObject({ unit_id: 'A1', status: 'en_route' });
    for (const result of h.runtime.executor.execute.mock.results) expect(await result.value).toMatchObject({ success: true, data: { verified: true } });
  });

  it('retains a richer first-person urgent report through semantic interpretation and verified notes', async () => {
    const note = 'I have one running by the Ferris Wheel';
    const h = await make({ llmPlans: [plan('REPORT_FIELD_INCIDENT', { unitRef: 'A1', eventType: 'officer_assist', note })] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send(`Central, ${note}`);
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.writes('/api/radio/note')[0].body).toMatchObject({ call_id: 'OLD-CALL', note });
    expect(await h.lastResult()).toMatchObject({ success: true, data: { partialErrors: [] } });
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    expect(h.runtime.executor.execute.mock.calls.every(([request]) => request.action !== 'DECLARE_EMERGENCY')).toBe(true);
  });

  it.each([
    'shots fired',
    'Central, shots fired',
    'Central, A1, 10-33 emergency traffic',
  ])('retains a complete urgent declaration without activating the hardware emergency system: %s', async (transcript) => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send(transcript);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(await h.lastResult()).toMatchObject({ success: true, action: 'REPORT_FIELD_INCIDENT', data: { partialErrors: [] } });
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  });
});

describe('03-01 semantic fallback and existing authorization boundaries', () => {
  it.each([
    ['unknown target', 'mark Z9 available', [{ callsign: 'A1' }, { callsign: 'B2' }]],
    ['ambiguous normalized target', 'mark B 2 available', [{ callsign: 'A1' }, { callsign: 'B-2' }, { callsign: 'B 2' }]],
    ['two explicit targets', 'mark B2 and C3 available', [{ callsign: 'A1' }, { callsign: 'B2' }, { callsign: 'C3' }]],
    ['missing roster', 'mark B2 available', []],
  ])('uses semantics for %s instead of silently choosing the speaker', async (_label, transcript, units) => {
    const { planner, create } = semanticPlanner({ action: 'CLARIFY', input: {}, confidence: 1, clarification: 'Which unit should I use?' });
    const result = await planner.plan(plannerRequest(transcript, units));
    expect(result).toMatchObject({ action: 'CLARIFY', clarification: 'Which unit should I use?' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(modelPayload(create)).toMatchObject({ transcript, speakerCallsign: 'A1' });
  });

  it.each([
    "A1, don't mark B2 available; I asked for the time.",
    'A1, create a building check at Four Corners for B2, then read the notes.',
    'A1, "B2 is available" was what the caller said yesterday.',
  ])('forwards all original sentence evidence to semantics: %s', async (transcript) => {
    const { planner, create } = semanticPlanner();
    expect((await planner.plan(plannerRequest(transcript))).action).toBe('NO_ACTION');
    expect(create).toHaveBeenCalledTimes(1);
    expect(modelPayload(create).transcript).toBe(transcript);
  });

  it('does not execute a named status without the existing unit.write permission', async () => {
    const h = await make({ scopes: ['unit.read', 'call.read'] });
    await h.send('Central, mark B2 available');
    expect(h.writes()).toEqual([]);
    expect(await h.lastResult()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('retains authoritative unknown-target rejection after semantic interpretation', async () => {
    const h = await make({ llmPlans: [plan('SET_UNIT_STATUS', { unitRef: 'Z9', status: 'available' })] });
    await h.send('Central, mark Z9 available');
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes()).toEqual([]);
    expect(h.cad.units.find((unit) => unit.unit_number === 'A1').status).toBe('on_duty');
  });

  it('keeps identical named targets in their own dispatch centers', async () => {
    const first = await make({ center: 'center-a' });
    const second = await make({ center: 'center-b' });
    await first.send('Central, mark B2 available');
    expect(first.writes('/api/radio/status')).toHaveLength(1);
    expect(first.writes('/api/radio/status')[0]).toMatchObject({ center: 'center-a', body: { unit_id: 'B2', status: 'available' } });
    expect(second.writes()).toEqual([]);
    expect(second.cad.units.find((unit) => unit.unit_number === 'B2').status).toBe('on_duty');
  });

  it.each(['provider error', 'malformed response'])('never falls back to a phrase mutation after %s', async (failure) => {
    const h = await make();
    if (failure === 'provider error') h.llm.mockRejectedValueOnce(new Error('Synthetic provider unavailable'));
    else h.llm.mockResolvedValueOnce({ choices: [{ message: { content: '{not-json' } }] });
    await h.send('Central, do not mark B2 available');
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.spoken()).toHaveLength(1);
    expect(h.spoken()[0]).toContain('unable to process');
  });

  it('never uses a phrase mutation when semantic planning reaches its existing timeout', async () => {
    const h = await make();
    h.runtime.planner.timeoutMs = 25;
    let signal;
    h.llm.mockImplementationOnce((_request, options) => {
      signal = options.signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Synthetic abort'), { name: 'AbortError' })), { once: true });
      });
    });
    await h.send('Central, is B2 available?');
    expect(signal.aborted).toBe(true);
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.spoken()).toHaveLength(1);
    expect(h.spoken()[0]).toContain('unable to process');
  });
});
