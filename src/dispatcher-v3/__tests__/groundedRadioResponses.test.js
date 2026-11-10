import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw Error('Live STT prohibited'); },
  textToSpeech: () => { throw Error('Live TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({
  floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher',
}));
vi.mock('../../services/emergencyPagingService.js', () => ({
  pageEmergencyUnits: () => { throw Error('Live paging prohibited'); },
}));
vi.mock('openai', () => ({ AzureOpenAI: class {
  constructor() { throw Error('Paid model prohibited'); }
} }));
import { normalizeV3SemanticPlan } from '../semanticContract.js';
import { composeV3Response } from '../responseComposer.js';
import { V3_READ_ANSWER_FIELDS } from '../groundedAnswers.js';
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';

const normalized = (action, answerFocus, input = {}) =>
  normalizeV3SemanticPlan({ action, input, intentType: 'question', confidence: 1, answerFocus });
const spoken = (action, answerFocus, data, sharedIncident = null) =>
  composeV3Response({ plan: normalized(action, answerFocus), result: { success: true, data },
    speakerCallsign: 'A1', sharedIncident, now: new Date('2026-10-30T18:30:00Z') });
let opened, network;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  network = vi.fn(() => { throw Error('External network prohibited'); });
  vi.stubGlobal('fetch', network); opened = [];
});
afterEach(async () => {
  try {
    for (const h of opened) await h.close();
    expect(network).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});
async function make(opts = {}) {
  const h = await createHarness(opts); opened.push(h); return h;
}

describe('AI-DISP-V3-001 04-02 factual concise radio answer selection', () => {
  it('restricts answer selectors to known read-only CAD facts', () => {
    expect(V3_READ_ANSWER_FIELDS.GET_CALL).toContain('location');
    expect(normalized('GET_CALL', ['location', 'priority']).answerFocus).toEqual(['location', 'priority']);
    for (const invalid of [
      { action: 'CREATE_CALL', intentType: 'action_request', answerFocus: ['location'] },
      { action: 'GET_CALL', intentType: 'question', answerFocus: ['invented'] },
      { action: 'GET_CALL', intentType: 'question', answerFocus: [] },
      { action: 'GET_CALL', intentType: 'question', answerFocus: ['location', 'location'] },
      { action: 'GET_CALL', intentType: 'question', answerFocus: ['summary', 'priority'] },
      { action: 'GET_CALL', intentType: 'question',
        answerFocus: ['location', 'status', 'priority', 'nature', 'units'] },
      { action: 'NO_ACTION', intentType: 'conversation_only', answerFocus: ['status'] },
    ]) expect(() => normalizeV3SemanticPlan({ input: {}, ...invalid })).toThrow(/answer fields|read-answer/i);
  });

  it('answers a location question with the actual CAD location and no invented priority', () => {
    const text = spoken('GET_CALL', ['location'], { call: {
      call_id: 'C1', nature: 'ALARM', location: '100 Main Street', status: 'active', priority: 'high',
    } });
    expect(text).toMatch(/A1, call C1, at 100 Main Street/);
    expect(text).not.toMatch(/ALARM|active|priority/i);
  });

  it('returns only the requested facts and names unavailable CAD fields', () => {
    const call = { call: { call_id: 'C2', nature: 'FIRE', location: '200 Oak',
      status: 'active', priority: 'critical' } };
    expect(spoken('GET_CALL', ['nature', 'priority'], call))
      .toMatch(/nature FIRE; priority critical/);
    expect(spoken('GET_CALL', ['location'], { call: { call_id: 'C3' } }))
      .toMatch(/location not available in CAD/);
    expect(spoken('GET_CALL', ['priority'], call)).not.toContain('200 Oak');
  });

  it('reports the exact count for count-only searches without unrelated list chatter', () => {
    const calls = Array.from({ length: 8 }, (_, i) => ({ call_number: 'C' + i }));
    expect(spoken('SEARCH_CALLS', ['count'], { calls })).toBe('A1, 8 matching CAD calls.');
    expect(spoken('LIST_ACTIVE_CALLS', ['count'], { calls: [] })).toBe('A1, 0 active calls.');
    expect(spoken('SEARCH_CALLS', ['summary'], { calls: [{ nature: 'ALARM', location: 'Walmart' }] }))
      .toMatch(/ALARM.*Walmart/);
  });

  it('uses the same existing military-time convention for a requested time', () => {
    const value = spoken('TIME_CHECK', ['time'], { timestamp: '2026-10-30T18:30:00Z' });
    expect(value).toBe('A1, fourteen thirty hours.');
    expect(spoken('STATUS_CHECK', ['status'], { unit: { status: 'on_scene' } }))
      .toBe('A1, unit status on scene.');
    expect(spoken('STATUS_CHECK', ['status'], {})).toMatch(/not available in CAD/);
  });

  it('reports assignment membership from returned CAD fields, not model-supplied text', () => {
    const result = spoken('GET_CALL', ['units'], { call: { call_id: 'C1',
      assigned_units: [{ callsign: 'A1' }, { callsign: 'B2' }, { callsign: 'D4', active: false }] } });
    expect(result).toMatch(/assigned units A1, B2/);
    expect(result).not.toContain('D4');
    expect(spoken('GET_CALL', ['units'], { call: { call_id: 'C1' } }))
      .toMatch(/assigned units not available/);
  });

  it('never borrows a report from another call or converts a report into an established fact', () => {
    const shared = { verifiedCadFacts: true, provenance: 'fresh_center_authorized_cad',
      callId: 'C1', participatingUnits: ['A1', 'B2'],
      reports: [{ reportedBy: 'B2', text: 'Possible subject by the east door' }] };
    const same = spoken('GET_CALL', ['reports'], { call: { call_id: 'C1' } }, shared);
    expect(same).toMatch(/unverified report from B2.*Possible subject/);
    const different = spoken('GET_CALL', ['reports'], { call: { call_id: 'OTHER' } }, shared);
    expect(different).toMatch(/require a verified current incident/);
    expect(different).not.toContain('east door');
  });

  it('bounds long CAD-provided field values without turning them into model instructions', () => {
    const text = spoken('GET_CALL', ['number', 'nature', 'location', 'priority'],
      { call: { call_id: 'C1', nature: 'A'.repeat(1000),
        location: 'L'.repeat(1000), priority: 'P'.repeat(1000) } });
    expect(text.length).toBeLessThanOrEqual(420);
    expect(text).not.toContain('A'.repeat(500));
  });

  it('preserves verified action outcomes and unconfirmed write warnings', () => {
    expect(composeV3Response({ plan: { action: 'CREATE_CALL' }, speakerCallsign: 'A1',
      result: { success: true, data: { verified: false, call: { nature: 'ALARM' } } } }))
      .toMatch(/unable to verify/);
    expect(composeV3Response({ plan: { action: 'CREATE_CALL' }, speakerCallsign: 'A1',
      result: { success: false, outcome: 'unknown', submittedWrites: 1 } }))
      .toMatch(/Do not repeat/);
    expect(composeV3Response({ plan: { action: 'REPORT_FIELD_INCIDENT' }, speakerCallsign: 'A1',
      result: { success: false, outcome: 'partial', data: { unknownCount: 1 } } }))
      .toMatch(/unconfirmed/);
  });

  it('retains read focus per compound step and rejects focus on write steps', () => {
    const read = { id: 'read', action: 'GET_CALL', input: { callId: 'OLD-CALL' },
      answerFocus: ['location'] };
    const write = { id: 'write', action: 'SET_UNIT_STATUS',
      input: { unitRef: 'A1', status: 'available' }, dependsOn: [] };
    const plan = normalizeV3SemanticPlan({ intentType: 'action_request',
      actions: [read, write], confidence: 1 });
    expect(plan.actions[0].answerFocus).toEqual(['location']);
    expect(() => normalizeV3SemanticPlan({ intentType: 'action_request',
      actions: [read, { ...write, answerFocus: ['status'] }] }))
      .toThrow(/answer fields/);
  });

  it('traverses actual authenticated PTT, CAD read, response and floor delivery', async () => {
    const h = await make({ llmPlans: [{
      action: 'GET_CALL', intentType: 'question', input: { callId: 'OLD-CALL' },
      answerFocus: ['location'], confidence: 1,
    }] });
    await h.send('Central, where is the Walmart alarm?', 'B2');
    expect(h.spoken()).toHaveLength(1);
    expect(h.spoken()[0]).toMatch(/^B2, call .*Walmart/);
    expect(h.spoken()[0]).not.toMatch(/ALARM|priority|status/i);
    expect(h.writes()).toEqual([]);
    expect(h.relay.injectAudio).toHaveBeenCalledTimes(1);
    expect(h.floor.releaseFloor).toHaveBeenCalledTimes(1);
  });

  it('keeps a mixed read/write task truthful and answers the requested call detail', async () => {
    const h = await make({ llmPlans: [{
      intentType: 'action_request', confidence: 1, actions: [
        { id: 'read', action: 'GET_CALL', input: { callId: 'OLD-CALL' },
          answerFocus: ['location'] },
        { id: 'status', action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'available' },
          dependsOn: [] },
      ],
    }] });
    await h.send('Central, where is the Walmart alarm? Mark me available.');
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.spoken().at(-1)).toMatch(/Walmart.*available/i);
    expect(h.spoken().at(-1)).not.toMatch(/priority/i);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
  });
});
