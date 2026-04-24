// Task #541: auto-close primary calls on clear and progress unit to on duty.
//   - clear/available cascades into available + on_duty back-to-back
//   - the redundant "Close the call?" hail is gone for clear/available
//     primary_last paths (STATUS_CHANGE simple-available, handleClearConfirm
//     primary_last, handleClearConfirm R8 409 fallback)
//   - implicit-reassign primary_last keeps its "Close the call first?" hail
//     (different intent, out of scope)
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(320)),
  isConfigured: () => true,
}));

vi.mock('../llmIntentService.js', () => ({
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
    getUnitInfo: vi.fn(async () => ({ status: 'on_scene', zone: 'Z1' })),
    getDispositions: vi.fn(async () => ([])),
    matchDisposition: () => null,
    sendBroadcast: vi.fn(async () => ({ success: true })),
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
  const origLog = d.log?.bind(d);
  d.log = (event, payload) => { d.logs.push({ event, payload }); if (origLog) try { origLog(event, payload); } catch (_e) {} };
  return d;
}

describe('Task #541: handleClearConfirm simple-clear cascades available → on_duty', () => {
  it('CAD sees clearUnit, then updateUnitStatus(available), then updateUnitStatus(on_duty), in that order', async () => {
    // Speaker is non-primary on the call → simple-clear path.
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-7', call_number: 'CALL-7',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    const d = makeDispatcher();
    await d.handleClearConfirm('INDIANA-1', '10-98');

    expect(cadService.clearUnit).toHaveBeenCalledWith('INDIANA-1');
    const statusCalls = cadService.updateUnitStatus.mock.calls;
    expect(statusCalls.length).toBe(2);
    expect(statusCalls[0][0]).toBe('INDIANA-1');
    expect(statusCalls[0][1]).toBe('available');
    expect(statusCalls[1][0]).toBe('INDIANA-1');
    expect(statusCalls[1][1]).toBe('on_duty');

    // The spoken ack stays the simple "10-4, clear, <time>." — one short ack.
    expect(d.spoken.length).toBe(1);
    expect(d.spoken[0]).toMatch(/INDIANA-1, 10-4, clear\. .+ hours\./);
    // The cascade is logged under a single event name with success flags.
    expect(d.logs.some(l => l.event === 'AVAILABLE_THEN_ON_DUTY_CASCADE'
      && l.payload.availableSuccess === true
      && l.payload.onDutySuccess === true)).toBe(true);
  });

  it('if updateUnitStatus(available) fails, on_duty is NOT called and the existing ack still plays', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-7', call_number: 'CALL-7',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    cadService.updateUnitStatus.mockResolvedValueOnce({ success: false, error: 'CAD down' });
    const d = makeDispatcher();
    await d.handleClearConfirm('INDIANA-1', '10-98');

    const statusCalls = cadService.updateUnitStatus.mock.calls;
    // Only available was attempted; on_duty was guarded out.
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0][1]).toBe('available');

    // Existing ack still spoken (handleClearConfirm currently swallows status
    // failure on the simple-clear path and proceeds with the time stamp).
    expect(d.spoken[0]).toMatch(/10-4, clear\./);
    expect(d.logs.some(l => l.event === 'AVAILABLE_THEN_ON_DUTY_CASCADE'
      && l.payload.availableSuccess === false
      && l.payload.onDutyAttempted === false)).toBe(true);
  });
});

describe('Task #541: STATUS_CHANGE → available simple cascades available → on_duty', () => {
  it('after the in-progress clearUnit step, both available + on_duty are written for the speaker', async () => {
    const llm = await import('../llmIntentService.js');
    llm.isConfigured.mockReturnValue(true);
    llm.classifyIntent.mockResolvedValue({
      intent: 'STATUS_CHANGE', cadStatus: 'available', slots: {}, response: null,
    });
    // Speaker is on a non-primary call → simple cascade path.
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      call_id: 'CALL-7', call_number: 'CALL-7',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('available', 'INDIANA-1');

    expect(cadService.clearUnit).toHaveBeenCalledWith('INDIANA-1');
    const statusCalls = cadService.updateUnitStatus.mock.calls;
    expect(statusCalls.length).toBe(2);
    expect(statusCalls[0][1]).toBe('available');
    expect(statusCalls[1][1]).toBe('on_duty');
    expect(d.logs.some(l => l.event === 'AVAILABLE_THEN_ON_DUTY_CASCADE'
      && l.payload.availableSuccess === true
      && l.payload.onDutySuccess === true)).toBe(true);
  });

  it('STATUS_CHANGE → available simple with no current call still cascades available + on_duty', async () => {
    const llm = await import('../llmIntentService.js');
    llm.isConfigured.mockReturnValue(true);
    llm.classifyIntent.mockResolvedValue({
      intent: 'STATUS_CHANGE', cadStatus: 'available', slots: {}, response: null,
    });
    // No current call → no clearUnit, but the cascade still runs.
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('10-8', 'INDIANA-1');

    expect(cadService.clearUnit).not.toHaveBeenCalled();
    const statusCalls = cadService.updateUnitStatus.mock.calls;
    expect(statusCalls.length).toBe(2);
    expect(statusCalls[0][1]).toBe('available');
    expect(statusCalls[1][1]).toBe('on_duty');
  });

  it('if STATUS_CHANGE → available leg fails, the on_duty leg is NOT written', async () => {
    const llm = await import('../llmIntentService.js');
    llm.isConfigured.mockReturnValue(true);
    llm.classifyIntent.mockResolvedValue({
      intent: 'STATUS_CHANGE', cadStatus: 'available', slots: {}, response: null,
    });
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.updateUnitStatus.mockResolvedValueOnce({ success: false, error: 'boom' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('10-8', 'INDIANA-1');

    const statusCalls = cadService.updateUnitStatus.mock.calls;
    // Only available was attempted.
    expect(statusCalls.length).toBe(1);
    expect(statusCalls[0][1]).toBe('available');
    // Existing failure messaging is still spoken.
    expect(d.spoken.some(s => /CAD update did not go through|Unable to reach CAD/i.test(s))).toBe(true);
  });
});

describe('Task #541: clear/available primary_last skips "Close the call?" hail', () => {
  it('handleClearConfirm primary_last (no inline disposition) → AWAITING_DISPOSITION with disposition prompt, NO CAD writes', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-123', call_number: 'CALL-123',
      assigned_units: ['INDIANA-1'], primary_unit: 'INDIANA-1',
    });
    const d = makeDispatcher();
    await d.handleClearConfirm('INDIANA-1', '10-98');

    expect(d.spoken[0]).toMatch(/INDIANA-1, 10-4\. Go ahead with disposition for call CALL-123\./);
    expect(d.spoken[0]).not.toMatch(/Close the call\?/);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSITION);
    expect(session.state).not.toBe(cm.DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM);
    expect(session.slots.callNumber).toBe('CALL-123');
    // No CAD writes should have happened yet — the disposition flow handles them.
    expect(cadService.clearUnit).not.toHaveBeenCalled();
    expect(cadService.updateUnitStatus).not.toHaveBeenCalled();
    expect(cadService.disposeCall).not.toHaveBeenCalled();
  });

  it('STATUS_CHANGE → available primary_last (no inline disposition) → AWAITING_DISPOSITION with disposition prompt, NO CAD writes', async () => {
    const llm = await import('../llmIntentService.js');
    llm.isConfigured.mockReturnValue(true);
    llm.classifyIntent.mockResolvedValue({
      intent: 'STATUS_CHANGE', cadStatus: 'available', slots: {}, response: null,
    });
    cadService.resolveUnitCurrentCall.mockResolvedValue({
      call_id: 'CALL-123', call_number: 'CALL-123',
      assigned_units: ['INDIANA-1'], primary_unit: 'INDIANA-1',
    });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('available', 'INDIANA-1');

    expect(d.spoken[0]).toMatch(/INDIANA-1, 10-4\. Go ahead with disposition for call CALL-123\./);
    expect(d.spoken[0]).not.toMatch(/Close the call\?/);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSITION);
    expect(session.slots.callNumber).toBe('CALL-123');
    expect(cadService.clearUnit).not.toHaveBeenCalled();
    expect(cadService.updateUnitStatus).not.toHaveBeenCalled();
  });

  it('handleClearConfirm primary_last with INLINE disposition still goes straight to AWAITING_DISPOSE_CONFIRM (no regression)', async () => {
    const d = makeDispatcher();
    // handleClearUnit only sets state and prompts for confirmation — it does
    // NOT call resolveUnitCurrentCall, so the classifier mock is queued for
    // handleClearConfirm directly below.
    await d.handleClearUnit('INDIANA-1', '10-98 with a warning');
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-123', call_number: 'CALL-123',
      assigned_units: ['INDIANA-1'], primary_unit: 'INDIANA-1',
    });
    await d.handleClearConfirm('INDIANA-1', '10-4');

    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM);
    expect(session.slots.callNumber).toBe('CALL-123');
    expect(d.spoken[d.spoken.length - 1]).toMatch(/confirm close call CALL-123/i);
  });

  it('handleClearConfirm R8 409 fallback (primary, no inline disposition) → AWAITING_DISPOSITION, NO further CAD writes', async () => {
    // Speaker classifies as 'simple' so we hit the clearUnit call site, but
    // CAD answers 409 → R8 fallback. Result must still be the new disposition
    // prompt, not the old "Close the call?" hail.
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-9', call_number: 'CALL-9',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    cadService.clearUnit.mockResolvedValueOnce({ success: false, statusCode: 409, error: 'primary' });
    const d = makeDispatcher();
    await d.handleClearConfirm('INDIANA-1', '10-98');

    expect(d.spoken[0]).toMatch(/INDIANA-1, 10-4\. Go ahead with disposition for call CALL-9\./);
    expect(d.spoken[0]).not.toMatch(/Close the call\?/);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSITION);
    expect(session.slots.callNumber).toBe('CALL-9');
    // No status writes — the disposition flow will handle them.
    expect(cadService.updateUnitStatus).not.toHaveBeenCalled();
  });
});

describe('Task #541: executeDisposeCall cascades available → on_duty after disposeCall succeeds', () => {
  it('disposeCall, then updateUnitStatus(available), then updateUnitStatus(on_duty), in that order', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-123', call_number: 'CALL-123' },
    ]});
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'close call 123 report taken', 'CALL-123', 'report taken');

    expect(cadService.disposeCall).toHaveBeenCalledTimes(1);
    expect(cadService.disposeCall.mock.calls[0][0]).toBe('uuid-123');

    const statusCalls = cadService.updateUnitStatus.mock.calls;
    expect(statusCalls.length).toBe(2);
    expect(statusCalls[0][0]).toBe('INDIANA-1');
    expect(statusCalls[0][1]).toBe('available');
    expect(statusCalls[1][0]).toBe('INDIANA-1');
    expect(statusCalls[1][1]).toBe('on_duty');

    // Ack still natural — single utterance, no extra hail.
    expect(d.spoken.length).toBe(1);
    expect(d.spoken[0]).toMatch(/INDIANA-1, 10-4\. Call closed/);
  });

  it('if disposeCall returns success:false, the cascade does NOT run', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-123', call_number: 'CALL-123' },
    ]});
    cadService.disposeCall.mockResolvedValueOnce({ success: false, error: 'boom' });
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'close call 123 report taken', 'CALL-123', 'report taken');

    expect(cadService.updateUnitStatus).not.toHaveBeenCalled();
    expect(d.spoken.some(s => /unable to close call/i.test(s))).toBe(true);
  });
});

describe('Task #541: implicit-reassign primary_last branch is unchanged', () => {
  it('still parks unit in AWAITING_PRIMARY_CLOSE_CONFIRM and speaks "Close the call first?"', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['INDIANA-1'], primary_unit: 'INDIANA-1',
    }).mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['INDIANA-1'], primary_unit: 'INDIANA-1',
    });
    const d = makeDispatcher();
    const handled = await d._handleImplicitReassign('INDIANA-1', 'route to new',
      { call_id: 'CALL-NEW', call_number: 'CALL-NEW' }, 'assign');
    expect(handled).toBe(true);
    expect(cadService.clearUnit).not.toHaveBeenCalled();
    expect(cadService.assignUnitToCall).not.toHaveBeenCalled();
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM);
    expect(d.spoken[0]).toMatch(/Close the call first\?/);
  });
});
