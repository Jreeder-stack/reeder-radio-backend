import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(320)),
  isConfigured: () => true,
}));

vi.mock('../llmIntentService.js', () => ({
  isConfigured: () => false,
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
    resolveUnitCurrentCall: vi.fn(async () => ({ call_id: 'CALL-123', call_number: 'CALL-123', assigned_units: ['INDIANA-1'] })),
    rememberUnitUuid: vi.fn(),
    getCachedUnitUuid: vi.fn(() => null),
    clearUnit: vi.fn(async () => ({ success: true })),
    disposeCall: vi.fn(async () => ({ success: true })),
    cancelCallDirect: vi.fn(async () => ({ success: true })),
    reopenCall: vi.fn(async () => ({ success: true })),
    getCallDetails: vi.fn(async (id) => ({ success: true, id, call_id: id })),
    // Task #527: spoken-canonical resolution checks the active list. Default
    // to a fixture containing the call numbers the existing tests use so we
    // don't have to change every call site.
    getActiveCalls: vi.fn(async () => ({ calls: [
      { call_id: 'CALL-123', call_number: 'CALL-123' },
      { call_id: 'CALL-9', call_number: 'CALL-9' },
      { call_id: 'CALL-7', call_number: 'CALL-7' },
    ] })),
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
  d.speak = async (text) => { d.spoken.push(text); };
  d.addConversationExchange = () => {};
  return d;
}

describe('R9: dispose passes disposition AND notes', () => {
  it('forwards disposition as both args to disposeCall', async () => {
    const d = makeDispatcher();
    await d.executeDisposeCall('Indiana-1', 'report filed', 'CALL-123', 'report filed');
    expect(cadService.disposeCall).toHaveBeenCalledWith('CALL-123', 'report filed', 'report filed');
  });
});

describe('Task #512: close-call uses active-list fallback when per-unit endpoint blanks out', () => {
  it('does NOT say "no active call" when resolveUnitCurrentCall returns the call from the list fallback', async () => {
    // Simulate the wrapper finding the call only via the active-calls list
    // (e.g. CAD per-unit endpoint filtered out an "assigned" status call).
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'e9bc488f-16ed-4236-b839-b4e306897c7e',
      call_number: '1-26-000171',
      status: 'assigned',
      assigned_units: ['INDIANA-1'],
      has_active_call: true,
      source: 'active_list_fallback',
    });
    const d = makeDispatcher();
    // Call without an explicit callNumber so executeDisposeCall has to look it
    // up through the wrapper.
    await d.executeDisposeCall('INDIANA-1', 'report taken', null, 'report taken');
    expect(cadService.disposeCall).toHaveBeenCalledTimes(1);
    expect(cadService.disposeCall.mock.calls[0][0])
      .toBe('e9bc488f-16ed-4236-b839-b4e306897c7e');
    expect(d.spoken.some(s => /no active call/i.test(s))).toBe(false);
  });

  it('passes the cached unit UUID to the wrapper so UUID-only assigned_units resolve', async () => {
    // Simulate an earlier CAD event that taught the dispatcher this callsign's
    // CAD UUID via the rememberUnitUuid cache. The dispatcher must thread that
    // UUID through to resolveUnitCurrentCall so the wrapper can match an
    // assigned_units entry that contains ONLY the UUID (no callsign).
    cadService.getCachedUnitUuid.mockReturnValueOnce('unit-uuid-abc');
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'call-uuid-xyz',
      call_number: '1-26-000999',
      status: 'assigned',
      assigned_units: ['unit-uuid-abc'],
      has_active_call: true,
      source: 'active_list_fallback',
    });
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'report taken', null, 'report taken');
    expect(cadService.resolveUnitCurrentCall).toHaveBeenCalledWith(
      'INDIANA-1',
      expect.objectContaining({ unitUuid: 'unit-uuid-abc' }),
    );
    expect(cadService.disposeCall).toHaveBeenCalledWith(
      'call-uuid-xyz', expect.anything(), expect.anything(),
    );
    expect(d.spoken.some(s => /no active call/i.test(s))).toBe(false);
  });

  // Task #527: when the speaker isn't assigned and there are 0 (or 2+)
  // active calls, AI asks for the call number instead of saying
  // "no active call to close".
  it('asks "which call number?" when nothing resolves and active list is empty', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      callNumber: null, has_active_call: false, source: 'none',
    });
    cadService.getActiveCalls.mockResolvedValueOnce({ calls: [] });
    const d = makeDispatcher();
    await d.executeDisposeCall('INDIANA-1', 'report taken', null, 'report taken');
    expect(cadService.disposeCall).not.toHaveBeenCalled();
    expect(d.spoken.some(s => /which call number to close/i.test(s))).toBe(true);
    expect(d.spoken.some(s => /no active call to close/i.test(s))).toBe(false);
  });
});

describe('R8: primary-unit cascade from clear → close confirm', () => {
  it('with single unit (primary), asks to close call and parks unit in AWAITING_PRIMARY_CLOSE_CONFIRM', async () => {
    // Task #482: classifier now detects primary upfront — no longer needs a CAD 409.
    const d = makeDispatcher();
    await d.handleClearConfirm('Indiana-1', '10-98');
    expect(d.spoken[0]).toMatch(/primary on call CALL-123\. Close the call\?/);
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM);
    expect(session.slots.callNumber).toBe('CALL-123');
  });

  it('confirm cascades into AWAITING_DISPOSITION with the call number', async () => {
    const d = makeDispatcher();
    await d.handlePrimaryCloseConfirm('Indiana-1', '10-4', { callNumber: 'CALL-123' });
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSITION);
    expect(session.slots.callNumber).toBe('CALL-123');
    expect(d.spoken[0]).toMatch(/Go ahead with disposition/);
  });
});

describe('SEQ-10: cancel call', () => {
  it('with inline reason → AWAITING_CANCEL_CONFIRM', async () => {
    const d = makeDispatcher();
    await d.handleCancelCall('Indiana-1', 'cancel call CALL-9 created in error', {
      callNumber: 'CALL-9', reason: 'created in error',
    });
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM);
    expect(session.slots).toMatchObject({ callNumber: 'CALL-9', reason: 'created in error' });
    expect(d.spoken[0]).toMatch(/confirm cancel call CALL-9, created in error\?/);
  });

  it('without reason → AWAITING_CANCEL_REASON, prompts for reason', async () => {
    const d = makeDispatcher();
    await d.handleCancelCall('Indiana-1', 'cancel call CALL-9', { callNumber: 'CALL-9' });
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_REASON);
    expect(d.spoken[0]).toMatch(/go ahead with the reason for cancel/);
  });

  it('confirm resolves callNumber to callId and fires PUT (via cancelCallDirect)', async () => {
    cadService.getCallDetails.mockResolvedValueOnce({ success: true, id: 'uuid-9', call_id: 'uuid-9' });
    const d = makeDispatcher();
    await d.handleCancelConfirm('Indiana-1', '10-4', { callNumber: 'CALL-9', reason: 'created in error' });
    expect(cadService.cancelCallDirect).toHaveBeenCalledWith('uuid-9', 'created in error', 'created in error');
    expect(d.spoken[0]).toMatch(/Call CALL-9 cancelled, created in error/);
  });

  it('falls back to scanning active calls when getCallDetails has no id', async () => {
    cadService.getCallDetails.mockResolvedValueOnce({ success: false });
    cadService.getActiveCalls.mockResolvedValueOnce({ calls: [
      { id: 'uuid-9', call_number: 'CALL-9' },
      { id: 'uuid-7', call_number: 'CALL-7' },
    ]});
    const d = makeDispatcher();
    await d.handleCancelConfirm('Indiana-1', '10-4', { callNumber: 'CALL-9', reason: 'voided' });
    expect(cadService.cancelCallDirect).toHaveBeenCalledWith('uuid-9', 'voided', 'voided');
  });

  it('handleCancelCall falls back to current call when callNumber omitted', async () => {
    const d = makeDispatcher();
    await d.handleCancelCall('Indiana-1', 'cancel call', {});
    const session = cm.getUnitSessionState('Indiana-1');
    // mocked resolveUnitCurrentCall returns call_number CALL-123
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_REASON);
    expect(session.slots.callNumber).toBe('CALL-123');
  });
});

describe('SEQ-11: reopen call', () => {
  it('strict phrase with callNumber → fires reopenCall and acks', async () => {
    const d = makeDispatcher();
    await d.handleReopenCall('Indiana-1', 'reopen call CALL-9', { callNumber: 'CALL-9' });
    expect(cadService.reopenCall).toHaveBeenCalledWith('CALL-9');
    expect(d.spoken[0]).toMatch(/Call CALL-9 reopened/);
  });

  it('reopen sends the spoken callNumber, NOT a resolved UUID', async () => {
    cadService.getCallDetails.mockResolvedValueOnce({ success: true, id: 'uuid-9', call_id: 'uuid-9', call_number: 'CALL-9' });
    const d = makeDispatcher();
    await d.handleReopenCall('Indiana-1', 'reopen call CALL-9', { callNumber: 'CALL-9' });
    expect(cadService.reopenCall).toHaveBeenCalledWith('CALL-9');
    expect(cadService.reopenCall).not.toHaveBeenCalledWith('uuid-9');
  });

  it('without callNumber → asks which call', async () => {
    const d = makeDispatcher();
    await d.handleReopenCall('Indiana-1', 'reopen', {});
    expect(cadService.reopenCall).not.toHaveBeenCalled();
    expect(d.spoken[0]).toMatch(/which call number to reopen/);
  });
});

describe('Regex fallback (LLM down) recognizes CANCEL_CALL and REOPEN_CALL', () => {
  it('"reopen call CALL-9" is dispatched to handleReopenCall', async () => {
    const d = makeDispatcher();
    await d.processTranscriptWithRegex('reopen call CALL-9', 'Indiana-1');
    expect(cadService.reopenCall).toHaveBeenCalledWith('CALL-9');
  });

  it('"cancel call CALL-9, created in error" parks unit in AWAITING_CANCEL_CONFIRM with reason', async () => {
    const d = makeDispatcher();
    await d.processTranscriptWithRegex('cancel call CALL-9, created in error', 'Indiana-1');
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_CONFIRM);
    expect(session.slots).toMatchObject({ callNumber: 'CALL-9', reason: 'created in error' });
  });

  it('"cancel call CALL-9" without reason parks unit in AWAITING_CANCEL_REASON', async () => {
    const d = makeDispatcher();
    await d.processTranscriptWithRegex('cancel call CALL-9', 'Indiana-1');
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CANCEL_REASON);
    expect(session.slots.callNumber).toBe('CALL-9');
  });
});

describe('R10: per-unit serial queue for status updates', () => {
  it('serializes overlapping updates for the same unit', async () => {
    const d = makeDispatcher();
    const order = [];
    let releaseFirst;
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('start1');
      await new Promise(r => { releaseFirst = r; });
      order.push('end1');
      return { success: true };
    });
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('start2');
      order.push('end2');
      return { success: true };
    });

    const p1 = d._updateUnitStatusSerial('Indiana-1', 'ENRT');
    const p2 = d._updateUnitStatusSerial('Indiana-1', 'ARRVD');
    // Yield to let p1 start
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['start1']);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2']);
  });

  it('does not serialize across different units', async () => {
    const d = makeDispatcher();
    const order = [];
    let releaseA;
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('A-start');
      await new Promise(r => { releaseA = r; });
      order.push('A-end');
      return { success: true };
    });
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('B-start');
      order.push('B-end');
      return { success: true };
    });

    const pA = d._updateUnitStatusSerial('UNIT-A', 'ENRT');
    const pB = d._updateUnitStatusSerial('UNIT-B', 'ENRT');
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain('B-start');
    expect(order).toContain('B-end');
    expect(order).not.toContain('A-end');
    releaseA();
    await Promise.all([pA, pB]);
    expect(order[order.length - 1]).toBe('A-end');
  });

  it('assign waits for in-flight status update for the same unit', async () => {
    const d = makeDispatcher();
    const order = [];
    let release;
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('status-start');
      await new Promise(r => { release = r; });
      order.push('status-end');
      return { success: true };
    });
    cadService.assignUnitToCall.mockImplementationOnce(async () => { order.push('assign'); return { success: true }; });

    const pStatus = d._updateUnitStatusSerial('UNIT-X', 'ENRT');
    const pAssign = d._assignUnitToCallSerial('UNIT-X', 'CALL-1');
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['status-start']);
    release();
    await Promise.all([pStatus, pAssign]);
    expect(order).toEqual(['status-start', 'status-end', 'assign']);
  });

  it('addCallNote waits for in-flight status update for the same unit', async () => {
    const d = makeDispatcher();
    const order = [];
    let release;
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('status-start');
      await new Promise(r => { release = r; });
      order.push('status-end');
      return { success: true };
    });
    cadService.addCallNote.mockImplementationOnce(async () => { order.push('note'); return { success: true }; });

    const pStatus = d._updateUnitStatusSerial('UNIT-X', 'ENRT');
    const pNote = d._addCallNoteSerial('UNIT-X', 'CALL-1', 'a note');
    await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['status-start']);
    release();
    await Promise.all([pStatus, pNote]);
    expect(order).toEqual(['status-start', 'status-end', 'note']);
  });

  it('non-status lifecycle calls (clear) wait for in-flight status updates for the same unit', async () => {
    const d = makeDispatcher();
    // Make the speaker non-primary on the call so handleClearConfirm takes the
    // simple-clear path (which actually calls clearUnit).
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-123', call_number: 'CALL-123',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    const order = [];
    let releaseStatus;
    cadService.updateUnitStatus.mockImplementationOnce(async () => {
      order.push('status-start');
      await new Promise(r => { releaseStatus = r; });
      order.push('status-end');
      return { success: true };
    });
    cadService.clearUnit.mockImplementationOnce(async () => {
      order.push('clear');
      return { success: true };
    });

    const pStatus = d._updateUnitStatusSerial('Indiana-1', 'ENRT');
    const pClear = d.handleClearConfirm('Indiana-1', '10-98');
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['status-start']);
    releaseStatus();
    await Promise.all([pStatus, pClear]);
    expect(order.indexOf('clear')).toBeGreaterThan(order.indexOf('status-end'));
  });
});

describe('Task #482: clear/available cascades and disposition matching', () => {
  it('classifyClearOutcome → primary_last when unit is the only one assigned', async () => {
    const d = makeDispatcher();
    const outcome = await d._classifyClearOutcome('Indiana-1');
    expect(outcome.kind).toBe('primary_last');
    expect(outcome.call?.callId).toBe('CALL-123');
  });

  it('classifyClearOutcome → primary_with_others when others are still on the call', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-9', call_number: 'CALL-9',
      assigned_units: ['INDIANA-1', 'LINCOLN-3'], primary_unit: 'INDIANA-1',
    });
    const d = makeDispatcher();
    const outcome = await d._classifyClearOutcome('Indiana-1');
    expect(outcome.kind).toBe('primary_with_others');
    expect(outcome.otherUnits).toEqual(['LINCOLN-3']);
  });

  it('classifyClearOutcome → simple when speaker is not primary', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-9', call_number: 'CALL-9',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    const d = makeDispatcher();
    const outcome = await d._classifyClearOutcome('Indiana-1');
    expect(outcome.kind).toBe('simple');
  });

  it('handleClearConfirm refuses primary_with_others and stays IDLE without calling CAD', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-9', call_number: 'CALL-9',
      assigned_units: ['INDIANA-1', 'LINCOLN-3', 'BEAVER-2'], primary_unit: 'INDIANA-1',
    });
    const d = makeDispatcher();
    await d.handleClearConfirm('Indiana-1', '10-98');
    expect(cadService.clearUnit).not.toHaveBeenCalled();
    expect(d.spoken[0]).toMatch(/primary on call CALL-9/);
    expect(d.spoken[0]).toMatch(/LINCOLN-3 and BEAVER-2 still on the call/);
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.IDLE);
  });

  it('handleClearConfirm cascades primary_last with no inline disposition into AWAITING_PRIMARY_CLOSE_CONFIRM', async () => {
    const d = makeDispatcher();
    await d.handleClearConfirm('Indiana-1', '10-98');
    expect(cadService.clearUnit).not.toHaveBeenCalled();
    expect(d.spoken[0]).toMatch(/primary on call CALL-123\. Close the call\?/);
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_PRIMARY_CLOSE_CONFIRM);
    expect(session.slots.callNumber).toBe('CALL-123');
  });

  it('handleClearUnit captures inline disposition and handleClearConfirm jumps to AWAITING_DISPOSE_CONFIRM', async () => {
    const d = makeDispatcher();
    await d.handleClearUnit('Indiana-1', '10-98 with a report');
    let session = cm.getUnitSessionState('Indiana-1');
    expect(session.slots.inlineDisposition).toMatch(/report/i);
    await d.handleClearConfirm('Indiana-1', '10-4');
    session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM);
    expect(session.slots.callNumber).toBe('CALL-123');
    expect(session.slots.disposition).toBeTruthy();
    expect(d.spoken[d.spoken.length - 1]).toMatch(/confirm close call/i);
  });

  it('executeDisposeCall canonicalizes spoken disposition through cadService.matchDisposition', async () => {
    cadService.getDispositions = vi.fn(async () => ([
      { value: 'Report Taken', label: 'Report Taken' },
      { value: 'Warning Issued', label: 'Warning Issued' },
    ]));
    cadService.matchDisposition = (spoken, list) => {
      if (/report/i.test(spoken)) return { canonical: 'Report Taken', score: 0.9 };
      return null;
    };
    const d = makeDispatcher();
    await d.executeDisposeCall('Indiana-1', 'with a report', 'CALL-123', 'wrote a report');
    expect(cadService.disposeCall).toHaveBeenCalledWith('CALL-123', 'Report Taken', 'wrote a report');
  });

  it('executeDisposeCall falls back to raw text when matchDisposition returns null', async () => {
    cadService.getDispositions = vi.fn(async () => ([{ value: 'Other', label: 'Other' }]));
    cadService.matchDisposition = () => null;
    const d = makeDispatcher();
    await d.executeDisposeCall('Indiana-1', 'unique phrase', 'CALL-123', 'unique phrase');
    expect(cadService.disposeCall).toHaveBeenCalledWith('CALL-123', 'unique phrase', 'unique phrase');
  });

  it('_handleImplicitReassign clears speaker off old call (simple) before attaching to new call', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    }).mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    const d = makeDispatcher();
    const targetCall = { call_id: 'CALL-NEW', call_number: 'CALL-NEW' };
    const handled = await d._handleImplicitReassign('Indiana-1', 'route to new', targetCall, 'assign');
    expect(handled).toBe(true);
    expect(cadService.clearUnit).toHaveBeenCalledWith('Indiana-1');
    expect(cadService.assignUnitToCall).toHaveBeenCalledWith('Indiana-1', 'CALL-NEW');
  });

  it('_handleImplicitReassign refuses with primary_with_others and never touches CAD writes', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['INDIANA-1', 'LINCOLN-3'], primary_unit: 'INDIANA-1',
    }).mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['INDIANA-1', 'LINCOLN-3'], primary_unit: 'INDIANA-1',
    });
    const d = makeDispatcher();
    const handled = await d._handleImplicitReassign('Indiana-1', 'route to new',
      { call_id: 'CALL-NEW', call_number: 'CALL-NEW' }, 'assign');
    expect(handled).toBe(true);
    expect(cadService.clearUnit).not.toHaveBeenCalled();
    expect(cadService.assignUnitToCall).not.toHaveBeenCalled();
    expect(d.spoken[0]).toMatch(/primary on call CALL-OLD/);
  });

  it('_handleImplicitReassign returns false when speaker is not on a call (normal assign path)', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({});
    const d = makeDispatcher();
    const handled = await d._handleImplicitReassign('Indiana-1', 'route',
      { call_id: 'CALL-NEW', call_number: 'CALL-NEW' }, 'assign');
    expect(handled).toBe(false);
  });

  it('_handleImplicitReassign returns false when speaker is already on the target call', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-NEW', call_number: 'CALL-NEW', assigned_units: ['INDIANA-1'],
    });
    const d = makeDispatcher();
    const handled = await d._handleImplicitReassign('Indiana-1', 'on scene',
      { call_id: 'CALL-NEW', call_number: 'CALL-NEW' }, 'on_scene');
    expect(handled).toBe(false);
  });

  it('_extractInlineDisposition pulls the phrase out of the transcript', () => {
    const d = makeDispatcher();
    expect(d._extractInlineDisposition('10-98 with a report')).toMatch(/report/);
    expect(d._extractInlineDisposition('available, warning issued')).toMatch(/warning/);
    expect(d._extractInlineDisposition('clear with citation')).toMatch(/citation/);
    expect(d._extractInlineDisposition('10-8')).toBe(null);
    expect(d._extractInlineDisposition('en route')).toBe(null);
  });

  it('_formatUnitList formats one, two, and many units cleanly', () => {
    const d = makeDispatcher();
    expect(d._formatUnitList([])).toBe('');
    expect(d._formatUnitList(['lincoln-3'])).toBe('LINCOLN-3');
    expect(d._formatUnitList(['lincoln-3', 'beaver-2'])).toBe('LINCOLN-3 and BEAVER-2');
    expect(d._formatUnitList(['a-1', 'b-2', 'c-3'])).toBe('A-1, B-2, and C-3');
  });

  it('inline-disp cascade preserves raw spoken phrase as CAD notes, not the canonical value', async () => {
    cadService.getDispositions = vi.fn(async () => ([{ value: 'Report Taken', label: 'Report Taken' }]));
    cadService.matchDisposition = (spoken) => /report/i.test(spoken)
      ? { canonical: 'Report Taken', score: 0.9 } : null;
    const d = makeDispatcher();
    await d.handleClearUnit('Indiana-1', '10-98 with a report');
    await d.handleClearConfirm('Indiana-1', '10-4');
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_DISPOSE_CONFIRM);
    expect(session.slots.dispositionCanonical).toBe('Report Taken');
    expect(session.slots.dispositionNotes).toMatch(/report/i);
    expect(session.slots.dispositionNotes).not.toBe('Report Taken');
    await d.handleDisposeConfirm('Indiana-1', '10-4', session.slots);
    const [callId, code, notes] = cadService.disposeCall.mock.calls[0];
    expect(callId).toBe('CALL-123');
    expect(code).toBe('Report Taken');
    expect(notes).toMatch(/report/i);
    expect(notes).not.toBe('Report Taken');
  });

  it('_handleImplicitReassign refuses when CAD rejects the clear (success:false), does not assign', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    }).mockResolvedValueOnce({
      call_id: 'CALL-OLD', call_number: 'CALL-OLD',
      assigned_units: ['LINCOLN-3', 'INDIANA-1'], primary_unit: 'LINCOLN-3',
    });
    cadService.clearUnit.mockResolvedValueOnce({ success: false, error: 'CAD down' });
    const d = makeDispatcher();
    const handled = await d._handleImplicitReassign('Indiana-1', 'route to new',
      { call_id: 'CALL-NEW', call_number: 'CALL-NEW' }, 'assign');
    expect(handled).toBe(true);
    expect(cadService.clearUnit).toHaveBeenCalled();
    expect(cadService.assignUnitToCall).not.toHaveBeenCalled();
    expect(d.spoken[0]).toMatch(/unable to clear you from call CALL-OLD/);
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.IDLE);
  });
});

