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

describe('Task #490: status-check spoken prompts drop call number', () => {
  it('status_check_due speaks "<unit>, status check." with no call number', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1', 'CALL-1'));
    expect(d.spoken).toHaveLength(1);
    expect(d.spoken[0]).toBe('INDIANA-1, status check.');
    expect(d.spoken[0]).not.toMatch(/call/i);
  });

  it('status_check_escalated speaks "<unit>, status check. Respond now." with no call number', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(escalatedEvent('INDIANA-1', 'call-uuid-1', 'CALL-1'));
    expect(d.spoken).toHaveLength(1);
    expect(d.spoken[0]).toBe('INDIANA-1, status check. Respond now.');
    expect(d.spoken[0]).not.toMatch(/call CALL-1/);
  });

  it('CAD broadcast for escalation still includes the call number for dispatcher context', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(escalatedEvent('INDIANA-1', 'call-uuid-1', 'CALL-1'));
    expect(cadService.sendBroadcast).toHaveBeenCalledWith(
      'Status check escalated for INDIANA-1 (call CALL-1)', 'high',
    );
  });
});

describe('Task #490: rate-limits duplicate spoken prompts', () => {
  it('two status_check_due events for the same unit+call within the interval => one spoken prompt + RATE_LIMITED log', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    // Simulate the unit not having responded yet — clear the pending entry to
    // emulate a fresh `due` on a new check id (e.g. WS + poll race) without
    // hitting the existing per-key dedupe.
    d._pendingStatusChecks.clear();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(1);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RATE_LIMITED')).toBe(true);
  });

  it('escalation upgrade after a recent non-escalated due is still spoken', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(1);
    await d._onCadStatusCheckEvent(escalatedEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(2);
    expect(d.spoken[1]).toBe('INDIANA-1, status check. Respond now.');
  });

  it('after status_check_acknowledged, a new status_check_due for the same unit+call speaks immediately', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(1);
    // CAD acknowledged event — clears pending + rate limit window
    await d._onCadStatusCheckEvent({
      type: 'status_check_acknowledged',
      unitId: 'unit-uuid-INDIANA-1',
      unitNumber: 'INDIANA-1',
      callId: 'call-uuid-1',
      raw: {},
    });
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toHaveLength(2);
    expect(d.spoken[1]).toBe('INDIANA-1, status check.');
  });

  it('respects AI_STATUS_CHECK_MIN_INTERVAL_MS env override (0 disables rate limit)', async () => {
    const prev = process.env.AI_STATUS_CHECK_MIN_INTERVAL_MS;
    process.env.AI_STATUS_CHECK_MIN_INTERVAL_MS = '0';
    try {
      const d = makeDispatcher();
      await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
      d._pendingStatusChecks.clear();
      await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
      expect(d.spoken).toHaveLength(2);
    } finally {
      if (prev === undefined) delete process.env.AI_STATUS_CHECK_MIN_INTERVAL_MS;
      else process.env.AI_STATUS_CHECK_MIN_INTERVAL_MS = prev;
    }
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
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', '10-4');
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_RESPONDED' && l.details.status === '10-4')).toBe(true);
  });

  it('also normalizes "copy"/"roger"/"ten four" responses to status:"10-4"', async () => {
    const d = makeDispatcher();
    await d.handleStatusCheckResponse('INDIANA-1', 'copy', {
      statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-1',
    });
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', '10-4');
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
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'CALL-UUID-1', '10-4');
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
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', '10-4');
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

describe('Task #500: per-prompt timeout for status check', () => {
  it('due-flow timeout speaks one re-prompt and re-arms the session (suppresses default reset)', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(dueEvent('INDIANA-1', 'call-uuid-1'));
    expect(d.spoken).toEqual(['INDIANA-1, status check.']);

    const slots = { statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-INDIANA-1' };
    const handled = await d._onSessionPromptTimeout('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, slots);
    expect(handled).toBe(true);
    expect(d.spoken[1]).toBe('INDIANA-1, status check, second call.');
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_NO_RESPONSE' && l.details.prompt === 'due' && l.details.rePrompted === false)).toBe(true);

    // Pending entry is now marked rePrompted; second timeout must NOT re-prompt.
    const handled2 = await d._onSessionPromptTimeout('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, slots);
    expect(handled2).toBe(false);
    // Only the original prompt + the single re-prompt should have been spoken.
    expect(d.spoken.filter(s => s.includes('second call')).length).toBe(1);
  });

  it('escalated-flow timeout broadcasts a dispatcher alert and leaves pending entry for late ack', async () => {
    const d = makeDispatcher();
    await d._onCadStatusCheckEvent(escalatedEvent('INDIANA-1', 'call-uuid-1'));
    cadService.sendBroadcast.mockClear();

    const slots = { statusCheckCallId: 'call-uuid-1', statusCheckUnitUuid: 'unit-uuid-INDIANA-1' };
    const handled = await d._onSessionPromptTimeout('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, slots);
    expect(handled).toBe(false);

    expect(d.logs.some(l => l.action === 'STATUS_CHECK_NO_RESPONSE' && l.details.prompt === 'escalated')).toBe(true);
    expect(d.logs.some(l => l.action === 'STATUS_CHECK_ESCALATED_ALERT' && l.details.source === 'prompt_timeout')).toBe(true);
    expect(cadService.sendBroadcast).toHaveBeenCalledWith(
      expect.stringMatching(/Status check no response from INDIANA-1.*escalated/), 'high',
    );
    // Pending entry remains so a late "10-4" can still ack.
    expect(d._pendingStatusChecks.size).toBe(1);

    // And the durable ack path can still close it out.
    const acked = await d._maybeAckPendingStatusCheck('INDIANA-1', '10-4');
    expect(acked).toBe(true);
    expect(cadService.respondToStatusCheck).toHaveBeenCalledWith('INDIANA-1', 'call-uuid-1', '10-4');
  });

  it('non-status-check states fall through to default reset behavior', async () => {
    const d = makeDispatcher();
    const handled = await d._onSessionPromptTimeout('INDIANA-1', cm.DISPATCHER_STATE.AWAITING_LOCATION, {});
    expect(handled).toBe(false);
  });
});
