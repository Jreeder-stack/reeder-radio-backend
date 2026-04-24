// Task #527: shared call resolution for close / cancel / update.
// Asserts the resolution order (spoken_canonical → unit_current → sole_active
// → none), the sole-active confirmation flow, and that CAD writes always
// receive the canonical UUID — never the raw spoken number.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(320)),
  isConfigured: () => true,
}));

vi.mock('../llmIntentService.js', () => ({
  // Default: LLM disabled. Tests that need LLM dispatch flip isConfigured
  // and provide a classifyIntent stub before invoking processTranscriptWithLLM.
  isConfigured: vi.fn(() => false),
  classifyIntent: vi.fn(),
  answerWithData: vi.fn(),
  composeNatural: vi.fn(async (_unitId, draft) => draft),
  rewriteCallNote: vi.fn(async (_unitId, draft) => draft),
}));

vi.mock('../cadService.js', () => {
  const RADIO_STATUS = { EN_ROUTE_SECONDARY: 'ENRTS', ARRIVED_SECONDARY: 'ARRVDS' };
  return {
    RADIO_STATUS,
    extractActualStatusFromRejection: () => null,
    isConfigured: () => true,
    updateUnitStatus: vi.fn(async () => ({ success: true })),
    addCallNote: vi.fn(async () => ({ success: true })),
    resolveUnitCurrentCall: vi.fn(async () => ({
      callNumber: null, has_active_call: false, source: 'none',
    })),
    rememberUnitUuid: vi.fn(),
    getCachedUnitUuid: vi.fn(() => null),
    clearUnit: vi.fn(async () => ({ success: true })),
    disposeCall: vi.fn(async () => ({ success: true })),
    cancelCallDirect: vi.fn(async () => ({ success: true })),
    updateCall: vi.fn(async () => ({ success: true })),
    reopenCall: vi.fn(async () => ({ success: true })),
    getCallDetails: vi.fn(async (id) => ({ success: true, id, call_id: id })),
    getActiveCalls: vi.fn(async () => ({ calls: [] })),
    assignUnitToCall: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('../agencyKnowledge.js', () => ({
  resolveDestination: (text) => ({ kind: 'unique', place: { name: String(text).trim(), address: null } }),
  KNOWN_PLACES: [],
}));

vi.mock('../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => null,
  createChannelMessage: async () => null,
}));

let AIDispatcher;
let cadService;
let cm;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
  cadService = await import('../cadService.js');
});

function makeDispatcher() {
  const d = new AIDispatcher();
  d.connected = true;
  d.isRunning = true;
  d.channelName = 'CH-TEST';
  d.spoken = [];
  d.logs = [];
  d.speak = async (text) => { d.spoken.push(text); };
  d.addConversationExchange = () => {};
  // Capture log calls so we can assert CALL_RESOLVE telemetry.
  const origLog = d.log?.bind(d);
  d.log = (event, payload) => { d.logs.push({ event, payload }); if (origLog) try { origLog(event, payload); } catch (_e) {} };
  return d;
}

describe('Task #527: _resolveCallForAction resolution order', () => {
  it('(a) spoken canonical: resolves named call from active list regardless of assignment', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-171', call_number: '171', location: '123 Main' },
      { call_id: 'uuid-200', call_number: '200', location: '456 Oak' },
    ]});
    const d = makeDispatcher();
    const r = await d._resolveCallForAction({
      participantId: 'INDIANA-1', spokenCallNumber: '171', handlerName: 'close',
    });
    expect(r.source).toBe('spoken_canonical');
    expect(r.call.call_id).toBe('uuid-171');
    expect(r.call.call_number).toBe('171');
    // unit_current must NOT be consulted when spoken matched (a)
    expect(cadService.resolveUnitCurrentCall).not.toHaveBeenCalled();
    expect(d.logs.some(l => l.event === 'CALL_RESOLVE'
      && l.payload.source === 'spoken_canonical'
      && l.payload.handler === 'close'
      && l.payload.resolvedCallId === 'uuid-171')).toBe(true);
  });

  it('(a) spoken miss: refuses to fall back to unit_current — returns spokenNotFound', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-200', call_number: '200' },
    ]});
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      call_id: 'uuid-999', call_number: '999', has_active_call: true,
    });
    const d = makeDispatcher();
    const r = await d._resolveCallForAction({
      participantId: 'INDIANA-1', spokenCallNumber: '171', handlerName: 'close',
    });
    expect(r.source).toBe('none');
    expect(r.spokenNotFound).toBe(true);
    expect(cadService.resolveUnitCurrentCall).not.toHaveBeenCalled();
  });

  it('(b) unit_current: no spoken number, speaker is on a call → uses unit_current', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      call_id: 'uuid-555', call_number: '555', has_active_call: true,
    });
    const d = makeDispatcher();
    const r = await d._resolveCallForAction({
      participantId: 'INDIANA-1', spokenCallNumber: null, handlerName: 'cancel',
    });
    expect(r.source).toBe('unit_current');
    expect(r.call.call_id).toBe('uuid-555');
  });

  it('(c) sole_active: no spoken number, speaker not assigned, exactly one call → requiresConfirmation', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY', location: '1 Lone Ln' },
    ]});
    const d = makeDispatcher();
    const r = await d._resolveCallForAction({
      participantId: 'INDIANA-1', spokenCallNumber: null, handlerName: 'update',
    });
    expect(r.source).toBe('sole_active');
    expect(r.requiresConfirmation).toBe(true);
    expect(r.call.call_id).toBe('uuid-only');
  });

  it('(d) none: speaker not assigned, 0 active calls → source none, no flag', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [] });
    const d = makeDispatcher();
    const r = await d._resolveCallForAction({
      participantId: 'INDIANA-1', spokenCallNumber: null, handlerName: 'close',
    });
    expect(r.source).toBe('none');
    expect(r.spokenNotFound).toBeUndefined();
  });

  it('(d) none: 2+ active calls, speaker not assigned → source none', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'a', call_number: '1' },
      { call_id: 'b', call_number: '2' },
    ]});
    const d = makeDispatcher();
    const r = await d._resolveCallForAction({
      participantId: 'INDIANA-1', spokenCallNumber: null, handlerName: 'close',
    });
    expect(r.source).toBe('none');
  });
});

describe('Task #527: executeDisposeCall uses canonical UUID + sole-call confirm', () => {
  it('spoken number → disposeCall called with canonical UUID, not the spoken string', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-171', call_number: '171' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'close call 171, report taken', '171', 'report taken');
    expect(cadService.disposeCall).toHaveBeenCalled();
    expect(cadService.disposeCall.mock.calls[0][0]).toBe('uuid-171');
  });

  it('sole active (speaker unassigned) parks unit in AWAITING_SOLE_CALL_CLOSE_CONFIRM', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY', location: '1 Lone Ln' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'close the call', null, null);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_SOLE_CALL_CLOSE_CONFIRM);
    expect(session.slots.callId).toBe('uuid-only');
    expect(session.slots.callNumber).toBe('CALL-ONLY');
    expect(d.spoken[0]).toMatch(/only one call on the board, CALL-ONLY/i);
    expect(d.spoken[0]).toMatch(/close it\?/i);
    expect(cadService.disposeCall).not.toHaveBeenCalled();
  });

  it('sole-call close confirm + 10-4 with no disposition → bridges to AWAITING_DISPOSITION', async () => {
    const d = makeDispatcher();
    await d.handleSoleCallCloseConfirm('INDIANA-1', '10-4', {
      callId: 'uuid-only', callNumber: 'CALL-ONLY',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSITION);
    expect(session.slots.callId).toBe('uuid-only');
    expect(d.spoken[0]).toMatch(/go ahead with the disposition/i);
    expect(cadService.disposeCall).not.toHaveBeenCalled();
  });

  it('sole-call close confirm + 10-4 with disposition already captured → goes to AWAITING_DISPOSE_CONFIRM', async () => {
    const d = makeDispatcher();
    await d.handleSoleCallCloseConfirm('INDIANA-1', '10-4', {
      callId: 'uuid-only', callNumber: 'CALL-ONLY', disposition: 'report taken',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM);
    expect(session.slots.callId).toBe('uuid-only');
    expect(session.slots.disposition).toBe('report taken');
  });

  it('spoken number that does not exist → asks "which call number?", does not write', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-200', call_number: '200' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'close call 171', '171', null);
    expect(cadService.disposeCall).not.toHaveBeenCalled();
    expect(d.spoken.some(s => /can't find call 171/i.test(s)
      || /which call number to close/i.test(s))).toBe(true);
  });

  // Task #527 regression: when upstream confirmation passes a pre-resolved
  // canonical call_id via opts.preResolvedCallId, executeDisposeCall uses
  // it directly and bypasses spoken-resolution entirely.
  it('uses opts.preResolvedCallId for CAD write, bypassing resolver', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'e9bc488f-aaaa-4bbb-8ccc-1234567890ab', call_number: 'CALL-42' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall(
      'INDIANA-1', 'close call, report taken',
      'CALL-42', 'report taken',
      { preResolvedCallId: 'e9bc488f-aaaa-4bbb-8ccc-1234567890ab' },
    );
    expect(cadService.disposeCall).toHaveBeenCalled();
    expect(cadService.disposeCall.mock.calls[0][0])
      .toBe('e9bc488f-aaaa-4bbb-8ccc-1234567890ab');
  });

  it('preResolvedCallId works even when active list is empty', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [] });
    const d = makeDispatcher();
    await d.executeDisposeCall(
      'INDIANA-1', 'close call, report taken',
      null, 'report taken',
      { preResolvedCallId: 'e9bc488f-aaaa-4bbb-8ccc-1234567890ab' },
    );
    expect(cadService.disposeCall).toHaveBeenCalled();
    expect(cadService.disposeCall.mock.calls[0][0])
      .toBe('e9bc488f-aaaa-4bbb-8ccc-1234567890ab');
  });

  // Without preResolvedCallId, a UUID passed through `callNumber` must
  // NOT be silently trusted — only an exact match against the active
  // list (or unit-current resolution) is allowed.
  it('UUID-shaped spoken value missing from active list does NOT write', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', call_number: 'CALL-42' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall(
      'INDIANA-1', 'close call, report taken',
      'e9bc488f-aaaa-4bbb-8ccc-1234567890ab', 'report taken',
    );
    expect(cadService.disposeCall).not.toHaveBeenCalled();
    expect(d.spoken.some(s => /which call number to close/i.test(s)
      || /can't find call/i.test(s))).toBe(true);
  });

  // A formatted but non-UUID call number that doesn't appear in the
  // active list must NOT be written as canonical — we must ask the user.
  it('hyphenated non-UUID spoken value missing from active list does not write', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', call_number: 'CALL-42' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall(
      'INDIANA-1', 'close call 1-26-000171, report taken',
      '1-26-000171', 'report taken',
    );
    expect(cadService.disposeCall).not.toHaveBeenCalled();
    expect(d.spoken.some(s => /which call number to close/i.test(s)
      || /can't find call/i.test(s))).toBe(true);
  });

  // Numeric spoken shorthand with empty active list must NOT be written.
  it('numeric shorthand with empty active list does not write', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [] });
    const d = makeDispatcher();
    await d.executeDisposeCall(
      'INDIANA-1', 'close call 200, report taken',
      '200', 'report taken',
    );
    expect(cadService.disposeCall).not.toHaveBeenCalled();
  });

  it('unresolved close drops to IDLE, not AWAITING_DISPOSITION', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [] });
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'close the call', null, null);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.IDLE);
  });
});

describe('Task #527: handleCancelCall uses canonical UUID + sole-call confirm', () => {
  it('spoken number → AWAITING_CANCEL_CONFIRM with canonical callId in slots', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-9', call_number: 'CALL-9' },
    ]});
    const d = makeDispatcher();
    await d.handleCancelCall('INDIANA-1', 'cancel call CALL-9 created in error', {
      callNumber: 'CALL-9', reason: 'created in error',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM);
    expect(session.slots.callId).toBe('uuid-9');
  });

  it('sole active → AWAITING_SOLE_CALL_CANCEL_CONFIRM, preserves any reason', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY' },
    ]});
    const d = makeDispatcher();
    await d.handleCancelCall('INDIANA-1', 'cancel the call, voided', { reason: 'voided' });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_SOLE_CALL_CANCEL_CONFIRM);
    expect(session.slots.reason).toBe('voided');
    expect(session.slots.callId).toBe('uuid-only');
  });

  it('sole-call cancel confirm + 10-4 with reason → AWAITING_CANCEL_CONFIRM', async () => {
    const d = makeDispatcher();
    await d.handleSoleCallCancelConfirm('INDIANA-1', '10-4', {
      callId: 'uuid-only', callNumber: 'CALL-ONLY', reason: 'voided',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM);
    expect(session.slots.callId).toBe('uuid-only');
  });

  it('handleCancelConfirm uses preResolved callId without re-resolving', async () => {
    const d = makeDispatcher();
    await d.handleCancelConfirm('INDIANA-1', '10-4', {
      callNumber: 'CALL-9', callId: 'uuid-9', reason: 'voided',
    });
    expect(cadService.cancelCallDirect).toHaveBeenCalledWith('uuid-9', 'voided', 'voided');
    expect(cadService.getCallDetails).not.toHaveBeenCalled();
  });
});

describe('Task #527: sole-call confirm drops to IDLE on non-yes/non-deny intents', () => {
  it('AWAITING_SOLE_CALL_CLOSE_CONFIRM + STATUS_UPDATE intent → drops to IDLE, never closes', async () => {
    const llm = await import('../llmIntentService.js');
    llm.isConfigured.mockReturnValue(true);
    llm.classifyIntent.mockResolvedValue({
      intent: 'STATUS_UPDATE', slots: {}, response: null,
    });
    const d = makeDispatcher();
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_SOLE_CALL_CLOSE_CONFIRM, null, {
      callId: 'uuid-only', callNumber: 'CALL-ONLY',
    }, true);
    await d.processTranscriptWithLLM("what's the time", 'INDIANA-1');
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.IDLE);
    expect(cadService.disposeCall).not.toHaveBeenCalled();
    expect(d.logs.some(l => l.event === 'SOLE_CALL_CONFIRM_DROPPED')).toBe(true);
  });

  it('AWAITING_SOLE_CALL_CANCEL_CONFIRM + DENY → cleared with disregard, no write', async () => {
    const llm = await import('../llmIntentService.js');
    llm.isConfigured.mockReturnValue(true);
    llm.classifyIntent.mockResolvedValue({
      intent: 'DENY', slots: {}, response: null,
    });
    const d = makeDispatcher();
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_SOLE_CALL_CANCEL_CONFIRM, null, {
      callId: 'uuid-only', callNumber: 'CALL-ONLY',
    }, true);
    await d.processTranscriptWithLLM('negative', 'INDIANA-1');
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.IDLE);
    expect(cadService.cancelCallDirect).not.toHaveBeenCalled();
  });
});

describe('Task #527: handleUpdateCall uses canonical UUID + sole-call confirm', () => {
  it('sole active with details → AWAITING_SOLE_CALL_UPDATE_CONFIRM, preserves updates', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY' },
    ]});
    const d = makeDispatcher();
    await d.handleUpdateCall('INDIANA-1', 'update call', { priority: '2', details: 'add suspect info' });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_SOLE_CALL_UPDATE_CONFIRM);
    expect(session.slots.callId).toBe('uuid-only');
    expect(session.slots.updates).toMatchObject({ priority: '2', notes: 'add suspect info' });
  });

  it('sole-call update confirm + 10-4 with updates → AWAITING_CALL_UPDATE_CONFIRM', async () => {
    const d = makeDispatcher();
    await d.handleSoleCallUpdateConfirm('INDIANA-1', '10-4', {
      callId: 'uuid-only', callNumber: 'CALL-ONLY',
      updates: { priority: '2', notes: 'info' },
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_UPDATE_CONFIRM);
    expect(session.slots.callId).toBe('uuid-only');
  });

  it('sole-call update confirm + 10-4 with no updates → bridges to AWAITING_CALL_UPDATE_DETAILS', async () => {
    const d = makeDispatcher();
    await d.handleSoleCallUpdateConfirm('INDIANA-1', '10-4', {
      callId: 'uuid-only', callNumber: 'CALL-ONLY', updates: null,
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_UPDATE_DETAILS);
    expect(session.slots.callId).toBe('uuid-only');
  });
});
