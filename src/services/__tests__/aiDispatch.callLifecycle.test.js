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
    getUnitCurrentCallById: vi.fn(async () => ({ call_id: 'CALL-123', call_number: 'CALL-123', assigned_units: ['INDIANA-1'] })),
    clearUnit: vi.fn(async () => ({ success: true })),
    disposeCall: vi.fn(async () => ({ success: true })),
    cancelCallDirect: vi.fn(async () => ({ success: true })),
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

describe('R8: primary-unit 409 cascade from clear → close confirm', () => {
  it('on 409, asks to close call and parks unit in AWAITING_PRIMARY_CLOSE_CONFIRM', async () => {
    cadService.clearUnit.mockResolvedValueOnce({ success: false, statusCode: 409, error: 'primary unit' });
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
    // mocked getUnitCurrentCallById returns call_number CALL-123
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
