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
  constructor() { throw new Error('Paid model prohibited'); }
} }));

import {
  V3_INTENT_TYPES, normalizeV3SemanticPlan, listV3SemanticCapabilities,
  buildV3SemanticModelContext,
} from '../semanticContract.js';
import { V3IntentPlanner } from '../intentPlanner.js';
import { START_TIME, createHarness, plan } from './helpers/auditRuntimeHarness.js';

const operation = (intentType, action, input = {}, extras = {}) => ({
  intentType, action, input, confidence: 1, ...extras,
});
const ask = (intentType, action, input = {}) => operation(intentType, action, input);
let all, network;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-no-network');
  network = vi.fn(() => { throw new Error('External network forbidden in 03-02'); });
  vi.stubGlobal('fetch', network);
  all = [];
});
afterEach(async () => {
  try {
    for (const h of all) await h.close();
    expect(network).not.toHaveBeenCalled();
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
  all.push(h);
  return h;
}
const modelPayload = h => JSON.parse(h.llm.mock.calls.at(-1)[0].messages[1].content);

describe('AI-DISP-V3-001 03-02 one structured semantic contract', () => {
  it('has explicit categories for operations, questions, reports, control, conversation, and gate-only silence', () => {
    expect(V3_INTENT_TYPES).toEqual([
      'action_request', 'question', 'observation', 'correction', 'cancellation',
      'clarification', 'conversation_only', 'unaddressed',
    ]);
  });

  it('normalizes deterministic status commands and status questions through the same contract', async () => {
    const client = { chat: { completions: { create: vi.fn(() => { throw Error('No model'); }) } } };
    const planner = new V3IntentPlanner({ client });
    expect(await planner.plan({ transcript: 'available', speakerCallsign: 'A1' }))
      .toMatchObject({ action: 'SET_UNIT_STATUS', intentType: 'action_request',
        input: { unitRef: 'A1', status: 'available' } });
    expect(await planner.plan({ transcript: "what's my status", speakerCallsign: 'A1' }))
      .toMatchObject({ action: 'STATUS_CHECK', intentType: 'question',
        input: { unitRef: 'A1' } });
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it('gives the model only capabilities available to this runtime and never the hardware emergency tool', () => {
    const limited = listV3SemanticCapabilities({ scopes: ['unit.read', 'call.read'] });
    expect(limited.map(item => item.action)).toContain('STATUS_CHECK');
    expect(limited.map(item => item.action)).toContain('GET_CALL');
    expect(limited.map(item => item.action)).not.toContain('SET_UNIT_STATUS');
    expect(limited.map(item => item.action)).not.toContain('CREATE_CALL');
    expect(limited.map(item => item.action)).not.toContain('DECLARE_EMERGENCY');
    expect(listV3SemanticCapabilities({ scopes: [] }).map(item => item.action))
      .toEqual(expect.arrayContaining(['RADIO_CHECK', 'TIME_CHECK']));
  });

  it('keeps authenticated speaker distinct from named target and does not supply model-side authority', async () => {
    const h = await make({ llmPlans: [
      operation('action_request', 'SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' }),
    ] });
    expect(await h.send('Central, could you put B2 into available status?')).toBe(true);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.writes('/api/radio/status')[0].body.unit_id).toBe('B2');
    expect(h.cad.units.find(item => item.unit_number === 'A1').status).toBe('on_duty');
    const payload = modelPayload(h);
    expect(payload.speaker).toMatchObject({
      callsign: 'A1', unitId: 'center-a-A1', verifiedFromTrustedPtt: true,
    });
    expect(payload.availableActions).toContain('SET_UNIT_STATUS');
    expect(payload.availableActions).not.toContain('DECLARE_EMERGENCY');
    expect(JSON.stringify(payload)).not.toContain('synthetic-no-real-key');
    expect((await h.lastPlan()).intentType).toBe('action_request');
    expect((await h.lastResult()).data.verified).toBe(true);
  });

  it('routes unfamiliar status-information wording as a question, never a status mutation', async () => {
    const h = await make({ llmPlans: [
      ask('question', 'STATUS_CHECK', { unitRef: 'B2' }),
    ] });
    expect(await h.send('Central, would you tell me what state B2 is in at the moment?')).toBe(true);
    expect(h.writes()).toEqual([]);
    expect((await h.lastPlan()).intentType).toBe('question');
    expect((await h.lastResult()).action).toBe('STATUS_CHECK');
    expect(h.spoken().at(-1)).toMatch(/status is/i);
  });

  it('preserves a field observation as observation, not an implicit unit-status change', async () => {
    const h = await make({ llmPlans: [
      operation('observation', 'NO_ACTION', {}, { reason: 'observed earlier, not an instruction' }),
    ] });
    expect(await h.send('Central, earlier I noticed B2 looked available')).toBe(true);
    expect((await h.lastPlan()).intentType).toBe('observation');
    expect(h.writes()).toEqual([]);
    expect(h.cad.units.find(item => item.unit_number === 'B2').status).toBe('on_duty');
  });

  it('permits an authorized urgent operational report without confusing it with a status update or hardware activation', async () => {
    const h = await make({ llmPlans: [
      operation('observation', 'REPORT_FIELD_INCIDENT', {
        unitRef: 'A1', eventType: 'officer_assist', note: 'Subject walking north',
      }),
    ] });
    h.cad.current.set('A1', 'OLD-CALL');
    expect(await h.send('Central, subject walking north of the entrance')).toBe(true);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    expect(h.writes('/api/radio/status')).toEqual([]);
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    expect((await h.lastResult()).data).toBeDefined();
  });

  it('rejects question-versus-mutation contradiction with a specific non-CAD clarification', async () => {
    const h = await make({ llmPlans: [
      operation('question', 'SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' }),
    ] });
    await h.send('Central, what status did B2 have earlier?');
    expect(h.writes()).toEqual([]);
    expect((await h.lastPlan()).action).toBe('CLARIFY');
    expect((await h.lastPlan()).intentType).toBe('clarification');
    expect(h.spoken().at(-1)).toMatch(/information or a CAD change/i);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });

  it('rejects an observational status mutation instead of changing a unit based on words alone', async () => {
    const h = await make({ llmPlans: [
      operation('observation', 'SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' }),
    ] });
    await h.send('Central, I saw B2 had been available');
    expect(h.writes()).toEqual([]);
    expect((await h.lastPlan()).action).toBe('CLARIFY');
    expect(h.spoken().at(-1)).toMatch(/report or a change to CAD/i);
  });

  it('keeps correction, cancellation, clarification and conversation-only as non-CAD classifications', () => {
    for (const [intentType, action] of [
      ['correction', 'CORRECT_TASK'], ['cancellation', 'CANCEL_TASK'],
      ['conversation_only', 'NO_ACTION'], ['conversation_only', 'NEW_TOPIC'],
      ['conversation_only', 'RESUME_TASK'],
    ]) {
      expect(normalizeV3SemanticPlan(operation(intentType, action))).toMatchObject({ action, intentType });
    }
    expect(normalizeV3SemanticPlan(operation('clarification', 'CLARIFY', {}, {
      clarification: 'Which incident?',
    }))).toMatchObject({ action: 'CLARIFY', intentType: 'clarification',
      clarification: 'Which incident?' });
  });

  it('does not convert a conversation-only reply or no matching CAD tool into a failed CAD operation', async () => {
    const h = await make({ llmPlans: [
      operation('conversation_only', 'NO_ACTION', {}, { reason: 'no matching CAD operation' }),
    ] });
    expect(await h.send('Central, thanks for the update, understood')).toBe(true);
    expect(await h.lastPlan()).toMatchObject({
      action: 'NO_ACTION', intentType: 'conversation_only',
    });
    expect(h.writes()).toEqual([]);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });

  it('lets the authenticated radio gate alone identify truly unaddressed speech', async () => {
    const h = await make();
    expect(await h.send('B2, tell the shift supervisor when you are free', 'A1')).toBe(false);
    expect(h.llm).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
    expect(() => normalizeV3SemanticPlan(operation('unaddressed', 'NO_ACTION')))
      .toThrow(/Only the trusted radio gate/i);
  });

  it('blocks unknown action names and any proposed voice activation of hardware emergency', async () => {
    for (const action of ['DECLARE_EMERGENCY', 'UNRESTRICTED_DATABASE_QUERY']) {
      const h = await make({ llmPlans: [operation('action_request', action, { unitRef: 'A1' })] });
      await h.send('Central, I have a question regarding the current operation');
      expect((await h.lastPlan()).action).toBe('CLARIFY');
      expect(h.writes()).toEqual([]);
      expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    }
  });

  it('refuses model-supplied internal unit IDs and grants rather than treating them as trusted speaker identity', async () => {
    const h = await make({ llmPlans: [
      operation('action_request', 'SET_UNIT_STATUS', {
        unitId: 'center-b-B2', unitRef: 'B2', status: 'available', authorized: true,
      }),
    ] });
    await h.send('Central, would you set B2 to available');
    expect(h.writes()).toEqual([]);
    expect((await h.lastPlan()).action).toBe('CLARIFY');
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
  });

  it('model capability visibility is not an authorization grant to the executor', async () => {
    const h = await make({ scopes: ['call.read', 'unit.read'], llmPlans: [
      operation('action_request', 'SET_UNIT_STATUS', { unitRef: 'A1', status: 'available' }),
    ] });
    await h.send('Central, would you update my duty status to available?');
    expect(modelPayload(h).availableActions).not.toContain('SET_UNIT_STATUS');
    expect(h.writes()).toEqual([]);
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
  });

  it('retains only the current authenticated unit history, not another unit dialogue or unverified CAD note', async () => {
    const h = await make({ llmPlans: [
      operation('question', 'GET_CURRENT_CALL', { unitRef: 'A1' }),
    ] });
    await h.send('Central, available', 'B2');
    await h.send('Central, could you remind me which incident I am currently assigned to?', 'A1');
    const payload = modelPayload(h);
    expect(payload.recentContext).toEqual([]);
    expect(payload.sharedIncident).toBeNull();
    expect(JSON.stringify(payload)).not.toContain('B2,');
  });

  it('validates compound operations and prevents an invented tool or mixed question/write plan', () => {
    const valid = normalizeV3SemanticPlan({
      intentType: 'action_request', actions: [
        { action: 'ASSIGN_UNIT', input: { unitRef: 'A1', callRef: 'fight' } },
        { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'en_route' } },
      ], confidence: 1,
    });
    expect(valid).toMatchObject({ action: 'MULTI_ACTION', intentType: 'action_request', actions: [
      { action: 'ASSIGN_UNIT', input: { unitRef: 'A1', callRef: 'fight' } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'en_route' } },
    ] });
    expect(() => normalizeV3SemanticPlan({
      intentType: 'question', actions: [
        { action: 'GET_CALL', input: { callId: 'OLD-CALL' } },
        { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'available' } },
      ], confidence: 1,
    })).toThrow(/question cannot be a CAD mutation/i);
    expect(() => normalizeV3SemanticPlan({
      intentType: 'action_request',
      actions: [{ action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'available' } },
        { action: 'INVENTED_ACTION', input: {} }],
    })).toThrow(/unavailable voice action/i);
  });

  it('rejects nested or oversized untrusted model input rather than letting it reach handlers', () => {
    expect(() => normalizeV3SemanticPlan(
      operation('action_request', 'SET_UNIT_STATUS', { unitRef: { anotherCenter: 'B2' } }),
    )).toThrow(/Unsupported value/i);
    expect(() => normalizeV3SemanticPlan(
      operation('action_request', 'SET_UNIT_STATUS', { unitRef: 'B2', note: 'a'.repeat(1501) }),
    )).toThrow(/too long/i);
    expect(() => normalizeV3SemanticPlan(
      operation('action_request', 'SET_UNIT_STATUS', JSON.parse('{"__proto__":"evil"}')),
    )).toThrow(/Invalid semantic input field/i);
    expect(() => normalizeV3SemanticPlan(null)).toThrow(/must be an object/i);
  });

  it('preserves a specific pending clarification without ever treating its model proposal as an authorization grant', () => {
    const plan = normalizeV3SemanticPlan({
      action: 'CLARIFY', intentType: 'clarification', confidence: 0.9,
      clarification: 'Which call?',
      pendingTask: {
        action: 'ASSIGN_UNIT', input: { unitRef: 'A1', callRef: 'that call' },
        unresolvedField: 'callId', candidateIds: ['OLD-CALL'],
      },
    });
    expect(plan).toMatchObject({ action: 'CLARIFY', pendingTask: { action: 'ASSIGN_UNIT',
      unresolvedField: 'callId' } });
    expect(plan.pendingTask).not.toHaveProperty('authorized');
  });

  it('separates model evidence labels from actual trusted speaker ownership', () => {
    const candidate = buildV3SemanticModelContext({
      transcript: 'What was said on our shared call?',
      speakerCallsign: 'A1',
      runtimeContext: { dispatchCenterId: 'center-a', roomKey: 'OPS1',
        scopes: ['call.read', 'unit.read'] },
      recentContext: [{ transcript: 'Central, status check', action: 'STATUS_CHECK', success: true }],
      sharedIncident: {
        callId: 'OLD-CALL', verifiedCadFacts: true, provenance: 'fresh_center_authorized_cad',
        participatingUnits: ['A1', 'B2'], reportCount: 1,
        reports: [{ text: 'UNTRUSTED_NOTE_DO_NOT_INJECT' }],
      },
    });
    expect(candidate.sharedIncident).toMatchObject({ callId: 'OLD-CALL', reportCount: 1 });
    expect(JSON.stringify(candidate)).not.toContain('UNTRUSTED_NOTE_DO_NOT_INJECT');
    expect(candidate.speaker.verifiedFromTrustedPtt).toBe(false);
    expect(candidate.availableActions).toContain('GET_CALL');
    expect(candidate.availableActions).not.toContain('CREATE_CALL');
  });
});
