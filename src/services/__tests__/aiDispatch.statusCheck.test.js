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
    getUnitCurrentCallById: vi.fn(async () => ({
      call_id: 'CALL-UUID-1', call_number: 'CALL-1', assigned_units: ['INDIANA-1'],
    })),
    clearUnit: vi.fn(async () => ({ success: true })),
    disposeCall: vi.fn(async () => ({ success: true })),
    cancelCallDirect: vi.fn(async () => ({ success: true })),
    reopenCall: vi.fn(async () => ({ success: true })),
    getCallDetails: vi.fn(async (id) => ({ success: true, id, call_id: id })),
    getActiveCalls: vi.fn(async () => ({ calls: [] })),
    assignUnitToCall: vi.fn(async () => ({ success: true })),
    respondToStatusCheck: vi.fn(async () => ({ success: true })),
    cancelStatusCheck: vi.fn(async () => ({ success: true, statusCode: 200 })),
    snoozeStatusCheck: vi.fn(async () => ({ success: true })),
    categorizeNoteFailure: () => null,
    sendBroadcast: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('../cadStatusCheckClient.js', () => ({
  cadStatusCheckClient: {
    start: vi.fn(),
    stop: vi.fn(),
    markSelfResponded: vi.fn(),
  },
}));

vi.mock('../agencyKnowledge.js', () => ({
  resolveDestination: (text) => ({ kind: 'unique', place: { name: String(text).trim(), address: null } }),
  KNOWN_PLACES: [],
}));

vi.mock('../../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => null,
  createChannelMessage: async () => null,
  getRecentAudioMessageBySender: async () => null,
  getAllFcmTokensForUnit: vi.fn(async () => [{ fcm_token: 'TOKEN-1', radio_id: 'R1' }]),
  getPagingChannelId: vi.fn(async () => 'PAGING-CH-1'),
  createPage: vi.fn(async () => ({ id: 42 })),
}));

vi.mock('../fcmService.js', () => ({
  sendPageToList: vi.fn(async () => ({ memberCount: 1, tokenCount: 1, page: { id: 1 } })),
  sendPageToTokens: vi.fn(async () => ({ successCount: 1, failureCount: 0, results: [] })),
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
  d.log = (action, details = {}) => {
    d.logs.push({ action, details });
    if (typeof origLog === 'function') origLog(action, details);
  };
  return d;
}

function dueEvent(unitId, callId, callNumber = 'CALL-1') {
  return {
    type: 'status_check_due',
    unitId: 'unit-uuid-' + unitId,
    unitNumber: unitId,
    callId,
    raw: { call_number: callNumber, id: 'check-' + Date.now() + Math.random() },
  };
}

function escalatedEvent(unitId, callId, callNumber = 'CALL-1') {
  return {
    type: 'status_check_escalated',
    unitId: 'unit-uuid-' + unitId,
    unitNumber: unitId,
    callId,
    raw: { call_number: callNumber, id: 'check-' + Date.now() + Math.random() },
  };
}

describe('Task #501: AI-driven routine status check escalation', () => {
  it('status_check_due hails "<unit>, central." (no longer "status check") and starts the controller', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1', 'CALL-1'));
    expect(d.spoken).toHaveLength(1);
    expect(d.spoken[0]).toBe('INDIANA-1, central.');
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_HAIL_1')).toBe(true);
  });

  it('CAD status_check_escalated event is ignored (no second prompt) when controller is driving', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(1);
    await d._onCadStatusCheckEvent(escalatedEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(1);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATED_CAD_EVENT_IGNORED')).toBe(true);
    expect(cadService.sendBroadcast).not.toHaveBeenCalled();
  });

  it('after the unit answers "go ahead", controller speaks "Status check." and waits for ack', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(1);
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_GO_AHEAD',
      statusCheckEscalationActive: true,
    }, true);
    await d.handleStatusCheckResponse('INDIANA-1', 'go ahead', {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_GO_AHEAD',
    });
    // give the queued speak() microtask a chance to land
    await Promise.resolve(); await Promise.resolve();
    expect(d.spoken).toContain('Status check.');
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_GO_AHEAD')).toBe(true);
  });

  it('OK ack from the unit cancels the escalation and replies "10-4, HH:MM."', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_RESPONSE',
      statusCheckEscalationActive: true,
    }, true);
    await d.handleStatusCheckResponse('INDIANA-1', '10-4', {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_RESPONSE',
    });
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(false);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_CANCELLED'
      && l.details.reason === 'acknowledged')).toBe(true);
    const ack = d.spoken[d.spoken.length - 1];
    expect(ack).toMatch(/^10-4, .+\.$/);
    expect(ack).not.toBe('INDIANA-1, 10-4.');
  });
});

describe('Task #501: escalation timer cadence', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('escalates through hail-2 → unit page → roster page+all-call → completed', async () => {
    const d = makeDispatcher();
    const tones = [];
    d.playToneAndSpeak = async (tone, msg) => { tones.push({ tone, msg }); };
    d.resolveUnitLocation = async () => '123 Main St';
    const fcm = await import('../fcmService.js');
    const db = await import('../../db/index.js');

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken[0]).toBe('INDIANA-1, central.');

    // Hail #2 at 30s
    await vi.advanceTimersByTimeAsync(30000);
    expect(d.spoken.filter(s => s === 'INDIANA-1, central.')).toHaveLength(2);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_HAIL_2')).toBe(true);

    // Unit page + tone at 60s
    await vi.advanceTimersByTimeAsync(30000);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_UNIT_PAGE')).toBe(true);
    expect(db.getAllFcmTokensForUnit).toHaveBeenCalledWith('INDIANA-1');
    expect(db.createPage).toHaveBeenCalledWith('STATUS CHECK — INDIANA-1', 'AI-DISPATCH', 'unit', 'INDIANA-1', null);
    expect(fcm.sendPageToTokens).toHaveBeenCalled();
    expect(tones.some(t => t.tone === 'A' && t.msg === 'INDIANA-1, status check.')).toBe(true);

    // Roster page + all-call at 90s
    await vi.advanceTimersByTimeAsync(30000);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_ROSTER_PAGE_ALLCALL'
      && l.details.location === '123 Main St')).toBe(true);
    expect(fcm.sendPageToList).toHaveBeenCalledWith(
      'emergency', 'STATUS CHECK ESCALATION — INDIANA-1 — 123 Main St', 'AI-DISPATCH', null,
    );
    expect(tones.some(t => t.tone === 'CONTINUOUS' && /Attention all units, status check escalation, INDIANA-1 at 123 Main St/.test(t.msg))).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_AWAITING_BACKUP')).toBe(true);

    // Completed after 60s waiting for another unit en-route
    await vi.advanceTimersByTimeAsync(60000);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_COMPLETED')).toBe(true);
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(false);
  });

  it('roster page falls back to "location unknown" when location resolution fails', async () => {
    const d = makeDispatcher();
    d.playToneAndSpeak = async () => {};
    d.resolveUnitLocation = async () => null;
    const fcm = await import('../fcmService.js');

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    await vi.advanceTimersByTimeAsync(90000); // through hail-2 + unit-page → roster step

    expect(fcm.sendPageToList).toHaveBeenCalledWith(
      'emergency', 'STATUS CHECK ESCALATION — INDIANA-1 — location unknown', 'AI-DISPATCH', null,
    );
  });

  it('OK ack cancels the timer chain — no further escalation steps fire', async () => {
    const d = makeDispatcher();
    d.playToneAndSpeak = async () => {};
    d.resolveUnitLocation = async () => null;
    const fcm = await import('../fcmService.js');

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_RESPONSE',
      statusCheckEscalationActive: true,
    }, true);
    await d.handleStatusCheckResponse('INDIANA-1', '10-4', {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_RESPONSE',
    });

    await vi.advanceTimersByTimeAsync(120000);
    expect(fcm.sendPageToList).not.toHaveBeenCalled();
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_HAIL_2')).toBe(false);
  });
});

describe('Task #501: en-route volunteer cancels escalation', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('another unit going en-route during the 60s backup window cancels the escalation immediately', async () => {
    const d = makeDispatcher();
    d.playToneAndSpeak = async () => {};
    d.resolveUnitLocation = async () => '500 Oak';

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    // Advance through HAIL_1 (0s) -> HAIL_2 (30s) -> UNIT_PAGE (60s) -> ROSTER (90s)
    await vi.advanceTimersByTimeAsync(90000);
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(true);
    const esc = d.routineStatusCheckEscalation.get('INDIANA-1', 'call-uuid-1');
    expect(esc.step).toBe(4);

    const intercepted = await d.routineStatusCheckEscalation.onUtterance('INDIANA-2', "I'll head that way");
    expect(intercepted).toBe(true);
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(false);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_VOLUNTEER'
      && l.details.volunteer === 'INDIANA-2')).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_CANCELLED'
      && l.details.reason === 'volunteer_en_route')).toBe(true);
    expect(d.spoken.some(s => /^INDIANA-2, 10-4, copy en route to check on INDIANA-1/.test(s))).toBe(true);

    // Confirm the 60s timer was cleared — no COMPLETED log fires.
    await vi.advanceTimersByTimeAsync(120000);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_COMPLETED')).toBe(false);
  });

  it('the silent unit responding does not count as a volunteer', async () => {
    const d = makeDispatcher();
    d.playToneAndSpeak = async () => {};
    d.resolveUnitLocation = async () => null;

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    await vi.advanceTimersByTimeAsync(90000);
    const intercepted = await d.routineStatusCheckEscalation.onUtterance('INDIANA-1', "I'll respond");
    expect(intercepted).toBe(false);
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(true);
  });

  it('AWAITING_BACKUP log records elapsed time at the transition', async () => {
    const d = makeDispatcher();
    d.playToneAndSpeak = async () => {};
    d.resolveUnitLocation = async () => null;

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    await vi.advanceTimersByTimeAsync(90000);
    const awaiting = d.logs.find(l => l.action === 'STATUS_CHECK_ESCALATION_AWAITING_BACKUP');
    expect(awaiting).toBeDefined();
    expect(awaiting.details.elapsedMs).toBeGreaterThanOrEqual(90000);
  });
});

describe('Task #501: CAD status_check_escalated fallback', () => {
  it('starts the AI escalation when no controller is active for that unit/call', async () => {
    const d = makeDispatcher();
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(false);
    await d._onCadStatusCheckEvent(escalatedEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(true);
    expect(d.spoken[0]).toBe('INDIANA-1, central.');
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATED_CAD_FALLBACK')).toBe(true);
  });
});

describe('Task #501: distress hand-off during escalation', () => {
  it('distress phrase from the same unit cancels escalation and starts the backup request flow', async () => {
    const d = makeDispatcher();
    let backupCalled = null;
    d.handleBackupRequestStart = async (unit, txt) => { backupCalled = { unit, txt }; };

    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_GO_AHEAD',
      statusCheckEscalationActive: true,
    }, true);
    await d.handleStatusCheckResponse('INDIANA-1', 'I need backup', {
      statusCheckCallId: 'call-uuid-1', statusCheckHailStage: 'AWAITING_GO_AHEAD',
    });

    expect(backupCalled).toEqual({ unit: 'INDIANA-1', txt: 'I need backup' });
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'call-uuid-1')).toBe(false);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATION_DISTRESS_HANDOFF')).toBe(true);
  });
});

describe('Task #490: ack round-trip resets CAD timer', () => {
  it('posts unit_id + call_id + status:"10-4" to respondToStatusCheck', async () => {
    const d = makeDispatcher();
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, null, {
      statusCheckId: 'check-1', statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-1',
    }, true);
    await d.handleStatusCheckResponse('INDIANA-1', '10-4', {
      statusCheckId: 'check-1', statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-1',
    });
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', { response: '10-4' });
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPONDED' && l.details.response === '10-4')).toBe(true);
  });

  it('also normalizes "copy"/"roger"/"ten four" responses to response:"10-4" (no status field)', async () => {
    const d = makeDispatcher();
    await d.handleStatusCheckResponse('INDIANA-1', 'copy', {
      statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-1',
    });
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', { response: '10-4' });
  });

  it('retries once on failure and logs STATUS_CHECK_RESPOND_FAILED (not RESPONDED) when both attempts fail', async () => {
    const d = makeDispatcher();
    cadService.respondToStatusCheck.mockResolvedValueOnce({ success: false, error: 'CAD down' });
    cadService.respondToStatusCheck.mockRejectedValueOnce(new Error('network error'));
    await d.handleStatusCheckResponse('INDIANA-1', '10-4', {
      statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-1',
    });
    expect(cadService.respondToStatusCheck).toHaveBeenCalledTimes(2);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPOND_FAILED')).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPONDED')).toBe(false);
    // Still speaks the ack and clears local pending state
    expect(d.spoken[0]).toBe('INDIANA-1, 10-4.');
  });

  it('retries once on failure and logs RESPONDED when the second attempt succeeds', async () => {
    const d = makeDispatcher();
    cadService.respondToStatusCheck.mockResolvedValueOnce({ success: false });
    cadService.respondToStatusCheck.mockResolvedValueOnce({ success: true });
    await d.handleStatusCheckResponse('INDIANA-1', '10-4', {
      statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-1',
    });
    expect(cadService.respondToStatusCheck).toHaveBeenCalledTimes(2);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPONDED' && l.details.attempts === 2)).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPOND_FAILED')).toBe(false);
  });

  it('falls back to _lookupCurrentCallId when the session slot lacks statusCheckCallId', async () => {
    const d = makeDispatcher();
    await d.handleStatusCheckResponse('INDIANA-1', '10-4', {
      statusCheckId: 'check-1', statusCheckCallId: null, statusCheckUnitUuid: 'unit-uuid-1',
    });
    expect(cadService.getUnitCurrentCallById).toHaveBeenCalledWith('INDIANA-1');
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'CALL-UUID-1', { response: '10-4' });
  });
});

describe('Task #500: durable status-check ack after session timeout', () => {
  it('still posts ack to CAD when session is IDLE but pending entry exists', async () => {
    const d = makeDispatcher();
    // Simulate a status check that fired and timed out (session reset to IDLE)
    // but the pending entry was intentionally left in place.
    d._pendingStatusChecks.set(d._pendingStatusCheckKey('INDIANA-1', 'call-uuid-1'), {
      unitId: 'INDIANA-1', callId: 'call-uuid-1', unitUuid: 'unit-uuid-1',
      escalated: true, rePrompted: true, at: Date.now(),
    });
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.IDLE, null, {}, true);

    const acked = await d._maybeAckPendingStatusCheck('INDIANA-1', '10-4');
    expect(acked).toBe(true);
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', { response: '10-4' });
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPONDED' && l.details.source === 'durable_ack')).toBe(true);
    expect(d._pendingStatusChecks.size).toBe(0);
  });

  it('logs STATUS_CHECK_SPEECH_IN diagnostic on every speech-in while a check is pending', async () => {
    const d = makeDispatcher();
    d._pendingStatusChecks.set(d._pendingStatusCheckKey('INDIANA-1', 'call-uuid-1'), {
      unitId: 'INDIANA-1', callId: 'call-uuid-1', escalated: false, rePrompted: false, at: Date.now(),
    });
    await d._maybeAckPendingStatusCheck('INDIANA-1', 'something not an ack');
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_SPEECH_IN' && l.details.handler === 'durable')).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_DURABLE_ACK_NO_MATCH')).toBe(true);
    expect(cadService.respondToStatusCheck).not.toHaveBeenCalled();
  });

  it('returns false when no pending entry exists for the unit', async () => {
    const d = makeDispatcher();
    const acked = await d._maybeAckPendingStatusCheck('INDIANA-1', '10-4');
    expect(acked).toBe(false);
    expect(cadService.respondToStatusCheck).not.toHaveBeenCalled();
  });
});

describe('Task #501: per-prompt timeout suppressed when escalation controller is active', () => {
  it('AWAITING_STATUS_CHECK_RESPONSE timeout is swallowed so the controller can drive timing', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toEqual(['INDIANA-1, central.']);

    const slots = { statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-INDIANA-1' };
    const handled = await d._onSessionPromptTimeout('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, slots);
    expect(handled).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_PROMPT_TIMEOUT_CONTROLLER_ACTIVE')).toBe(true);
    // Should not have spoken anything beyond the original hail.
    expect(d.spoken.filter(s => s.includes('second call')).length).toBe(0);
  });

  it('non-status-check states still fall through to default reset behavior', async () => {
    const d = makeDispatcher();
    const handled = await d._onSessionPromptTimeout('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_LOCATION, {});
    expect(handled).toBe(false);
  });
});

describe('Task #509: per-call cancel ("extended traffic stop") suspends status checks', () => {
  it('regex fast path on "extended traffic stop" routes to handleCancelStatusChecks and posts the new cancel URL', async () => {
    const d = makeDispatcher();
    cm.setUnitSessionState('INDIANA-1', cm.DISPATCHER_STATE.IDLE, null, {}, true);
    await d.processTranscriptWithRegex('extended traffic stop', 'INDIANA-1');
    expect(cadService.cancelStatusCheck).toHaveBeenCalledTimes(1);
    const args = cadService.cancelStatusCheck.mock.calls[0];
    expect(args[0]).toBe('INDIANA-1');
    expect(args[1]).toBe('CALL-UUID-1');
    expect(args[2]).toEqual({ reason: 'extended traffic stop' });
    expect(d.spoken.some(s => /^INDIANA-1, 10-4, status checks suspended for call /.test(s))).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_CANCEL_SENT' && l.details.success === true)).toBe(true);
  });

  it('cancels active escalation controller for the unit/call when CAD cancel succeeds', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'CALL-UUID-1', 'CALL-1'));
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'CALL-UUID-1')).toBe(true);
    await d.processTranscriptWithRegex('suspend status checks', 'INDIANA-1');
    expect(d.routineStatusCheckEscalation.has('INDIANA-1', 'CALL-UUID-1')).toBe(false);
  });

  it('on failure speaks "unable to suspend status checks" and logs the failure', async () => {
    const d = makeDispatcher();
    cadService.cancelStatusCheck.mockResolvedValueOnce({
      success: false, statusCode: 500, failureCategory: 'cad_5xx', error: 'boom',
    });
    await d.processTranscriptWithRegex('extended traffic stop', 'INDIANA-1');
    expect(d.spoken.some(s => /^INDIANA-1, unable to suspend status checks/.test(s))).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_CANCEL_SENT' && l.details.success === false)).toBe(true);
  });
});
