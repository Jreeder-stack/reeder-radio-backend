import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited in emergency containment tests'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited in emergency containment tests'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model client prohibited'); } } }));

import { NO_ACTION, START_TIME, createHarness, finish, observe, until } from './helpers/auditRuntimeHarness.js';

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

async function make() {
  const h = await createHarness({ llmPlans: [NO_ACTION] });
  harnesses.push(h);
  h.cad.current.set('A1', 'OLD-CALL');
  // Signaling is an external boundary. The actual hardware entry, emergency
  // lifecycle, PTT processing and CAD handlers are never replaced.
  h.runtime.signaling.endEmergencyForUnit = vi.fn();
  h.runtime.signaling._emitToChannelDispatchers = vi.fn();
  return h;
}

async function startHardwareEmergency({ escalated = false } = {}) {
  const h = await make();
  expect(await finish(observe(h.runtime.handleEmergencyStart(h.context.roomKey, 'A1')))).toBe(true);
  expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'status_check_1' });
  if (escalated) {
    await h.send('I need help', 'A1');
    expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'escalated', callId: 'OLD-CALL' });
  }
  return h;
}

describe('03-01 whole-sentence replies during a physical emergency', () => {
  it.each([
    'not all good',
    'am I okay?',
    'I said all good yesterday',
    'all good except I cannot move',
    'Central, not all good',
    'Central, "I am okay"',
    'Control, I am okay',
    'Central, B2, I am okay',
  ])('does not clear a hardware emergency from an unsafe or ambiguous reply: %s', async (transcript) => {
    const h = await startHardwareEmergency();
    const timersBefore = vi.getTimerCount();
    await h.send(transcript, 'A1');
    expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'status_check_1' });
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it.each(['Central, A1, I am okay', '10-4'])('still accepts an exact safe response from the activated unit: %s', async (transcript) => {
    const h = await startHardwareEmergency();
    await h.send(transcript, 'A1');
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    expect(h.runtime.signaling.endEmergencyForUnit).toHaveBeenCalledExactlyOnceWith('A1', 'status_check_safe_response');
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let another authenticated unit supply the safe reply for A1', async () => {
    const h = await startHardwareEmergency();
    await h.send('Central, A1, I am okay', 'B2');
    expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'status_check_1' });
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it('preserves the next hardware status-check timer after an unsafe reply', async () => {
    const h = await startHardwareEmergency();
    await h.send('not all good', 'A1');
    await vi.advanceTimersByTimeAsync(h.runtime.emergencyCheckMs);
    await until(() => h.runtime.getPipelineStatus().emergency?.stage === 'status_check_2' && h.runtime._emergencyTimers.size === 1, 'second hardware check scheduled');
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
    expect(h.spoken().filter((text) => text === 'A1, status check.')).toHaveLength(2);
  });

  it('preserves conservative distress escalation when a safe phrase is followed by a request for help', async () => {
    const h = await startHardwareEmergency();
    await h.send('I am okay but I need help', 'A1');
    expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'escalated', callId: 'OLD-CALL' });
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
    expect(h.runtime.signaling._emitToChannelDispatchers).toHaveBeenCalledWith(h.context.roomKey, 'emergency:start', expect.objectContaining({ unitId: 'A1' }));
  });

  it.each([
    'I am not responding',
    'is B2 responding?',
    'responding tomorrow',
    'Central, I am not responding',
    'Central, B2, responding after I finish this call',
    'Control, I am responding',
  ])('does not assign a responder from a substring or an unrecognized prefix: %s', async (transcript) => {
    const h = await startHardwareEmergency({ escalated: true });
    const writesBefore = h.writes().length;
    const timersBefore = vi.getTimerCount();
    await h.send(transcript, 'B2');
    expect(h.writes().slice(writesBefore)).toEqual([]);
    expect(h.writes('/api/radio/assign')).toEqual([]);
    expect(h.writes('/api/radio/status')).toEqual([]);
    expect(h.cad.current.get('B2')).toBeNull();
    expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'escalated', responders: [] });
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it('still assigns an exact affirmative responder to the active hardware incident', async () => {
    const h = await startHardwareEmergency({ escalated: true });
    await h.send('Central, B2, I am responding', 'B2');
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.writes('/api/radio/assign').map((request) => request.body)).toEqual([{ call_id: 'OLD-CALL', unit_id: 'B2' }]);
    expect(h.writes('/api/radio/status').map((request) => request.body)).toEqual([{ unit_id: 'B2', status: 'en_route' }]);
    expect(h.cad.current.get('B2')).toBe('OLD-CALL');
    expect(h.runtime.getPipelineStatus().emergency).toMatchObject({ unitId: 'A1', source: 'hardware', stage: 'escalated', responders: ['B2'] });
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
  });

  it('preserves the explicit hardware/manual clear entry point', async () => {
    const h = await startHardwareEmergency();
    expect(await h.runtime.handleEmergencyEnd(h.context.roomKey, 'A1')).toBe(true);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.writes()).toEqual([]);
  });

  it('still prevents urgent voice alone from activating hardware emergency state', async () => {
    const h = await make();
    await h.send('Central, officer down', 'A1');
    expect(await h.lastResult()).toMatchObject({ success: true, action: 'REPORT_FIELD_INCIDENT' });
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    expect(h.runtime.signaling.emergencyStates.size).toBe(0);
    expect(h.runtime.signaling._emitToChannelDispatchers).not.toHaveBeenCalled();
    expect(h.runtime.signaling.endEmergencyForUnit).not.toHaveBeenCalled();
  });
});
