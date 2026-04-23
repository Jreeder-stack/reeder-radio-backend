// Task #498: AI speaks "<unit>, 10-4." after a be-advised note is logged.
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
  rewriteCallNote: vi.fn(async (_unitId, draft) => ({ note: draft, confidence: 'high', rewritten: false })),
}));

vi.mock('../cadService.js', () => {
  const RADIO_STATUS = { EN_ROUTE_SECONDARY: 'ENRTS', ARRIVED_SECONDARY: 'ARRVDS' };
  return {
    RADIO_STATUS,
    extractActualStatusFromRejection: () => null,
    isConfigured: () => true,
    updateUnitStatus: vi.fn(async () => ({ success: true })),
    addCallNote: vi.fn(async () => ({ success: true })),
    resolveUnitCurrentCall: vi.fn(async () => ({ call_id: 'CALL-789', call_number: 'CALL-789', assigned_units: ['INDIANA-1'] })),
    rememberUnitUuid: vi.fn(),
    getCachedUnitUuid: vi.fn(() => null),
    clearUnit: vi.fn(async () => ({ success: true })),
    disposeCall: vi.fn(async () => ({ success: true })),
    cancelCallDirect: vi.fn(async () => ({ success: true })),
    reopenCall: vi.fn(async () => ({ success: true })),
    getCallDetails: vi.fn(async () => ({ success: true, call: {} })),
    getActiveCalls: vi.fn(async () => ({ calls: [] })),
    assignUnitToCall: vi.fn(async () => ({ success: true })),
    setPrimaryUnit: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('../agencyKnowledge.js', () => ({
  resolveDestination: (text) => ({ kind: 'unique', place: { name: String(text).trim(), address: null } }),
  KNOWN_PLACES: [],
}));

vi.mock('../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => 'CH-TEST',
  getAiSetting: async () => 'true',
  setAiSetting: async () => true,
  createChannelMessage: async () => null,
}));

let AIDispatcher;
let cadService;
let llm;
let cm;
let DISPATCHER_STATE;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  DISPATCHER_STATE = cm.DISPATCHER_STATE;
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
  cadService = await import('../cadService.js');
  llm = await import('../llmIntentService.js');
});

function makeDispatcher() {
  const d = new AIDispatcher();
  d.connected = true;
  d.isRunning = true;
  d.channelName = 'CH-TEST';
  d.spoken = [];
  d.exchanges = [];
  d.speak = async (text, _unit) => { d.spoken.push(text); };
  d.addConversationExchange = (unitId, transcript, response) => {
    d.exchanges.push({ unitId, transcript, response });
  };
  return d;
}

describe('Task #498: be-advised success path speaks 10-4 ack', () => {
  it('speaks "<unit>, 10-4." after the note is logged and records the exchange', async () => {
    llm.rewriteCallNote.mockResolvedValueOnce({
      note: "there's no one here waiting",
      confidence: 'high',
      rewritten: true,
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote(
      'INDIANA-1',
      "be advised there's no one here waiting",
      "be advised there's no one here waiting",
    );
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    const ackSpoken = d.spoken.find((s) => s.includes('10-4'));
    expect(ackSpoken).toBeTruthy();
    expect(ackSpoken).toContain('INDIANA-1');
    const ackExchange = d.exchanges.find((e) => e.response && e.response.includes('10-4'));
    expect(ackExchange).toBeTruthy();
    expect(ackExchange.transcript).toBe("be advised there's no one here waiting");
    const sess = cm.getUnitSessionState('INDIANA-1');
    expect(sess.state).toBe(DISPATCHER_STATE.IDLE);
  });

  it('does NOT speak 10-4 when CAD note add fails', async () => {
    llm.rewriteCallNote.mockResolvedValueOnce({ note: 'all clear', confidence: 'high', rewritten: true });
    cadService.addCallNote.mockResolvedValueOnce({ success: false });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'all clear', 'all clear');
    const said = d.spoken.join(' ');
    expect(said).not.toContain('10-4');
    expect(said.toLowerCase()).toContain('unable to add note');
  });

  it('does NOT speak 10-4 when speaker has no current call', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-9', 'be advised perimeter clear', 'be advised perimeter clear');
    expect(cadService.addCallNote).not.toHaveBeenCalled();
    const said = d.spoken.join(' ');
    expect(said).not.toContain('10-4');
    expect(said.toLowerCase()).toContain("not assigned to a call");
  });

  it('does NOT speak 10-4 when the rewrite confidence is low', async () => {
    llm.rewriteCallNote.mockResolvedValueOnce({ note: '', confidence: 'low', rewritten: false });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'mumble mumble', 'mumble mumble');
    expect(cadService.addCallNote).not.toHaveBeenCalled();
    const said = d.spoken.join(' ');
    expect(said).not.toContain('10-4');
    expect(said.toLowerCase()).toContain("didn't catch that note");
  });

  it('still calls addCallNote exactly once on success', async () => {
    llm.rewriteCallNote.mockResolvedValueOnce({ note: 'first floor clear', confidence: 'high', rewritten: true });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'first floor clear', 'first floor clear');
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
  });
});
