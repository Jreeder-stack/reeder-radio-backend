// Task #538: "be advised" / area-clear notes that ack but never log.
// The AI dispatcher must NEVER speak a bare "10-4" for a Category C
// area-clear / "be advised" transmission unless the note was actually
// written. These tests cover:
//   - the deterministic safety net that overrides SILENCE / DISREGARD /
//     STATUS_CHANGE when the transcript matches a Category C area-clear
//     phrase (with and without "be advised" / "I said" / "also" / "as
//     well" / "too"),
//   - the AWAITING_BE_ADVISED_NOTE retry fast-path remains intact,
//   - the rewrite-confidence guard now falls back to the raw transcript
//     verbatim instead of dropping the note,
//   - every executeBeAdvisedNote exit path that does NOT write the note
//     emits a structured BE_ADVISED_NOTE_DROPPED log,
//   - pure acks ("10-4", "copy", "roger") are still SILENCE.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../azureSpeechService.js', () => ({
  speechToText: vi.fn(async () => ({ text: '' })),
  textToSpeech: vi.fn(async () => Buffer.alloc(320)),
  isConfigured: () => true,
}));

vi.mock('../llmIntentService.js', () => ({
  isConfigured: () => true,
  classifyIntent: vi.fn(),
  answerWithData: vi.fn(),
  composeNatural: vi.fn(async (_unitId, draft) => draft),
  rewriteCallNote: vi.fn(async (_unitId, draft) => ({ note: draft, confidence: 'high', rewritten: false })),
}));

vi.mock('../cadService.js', () => {
  const RADIO_STATUS = { EN_ROUTE_SECONDARY: 'ENRTS', ARRIVED_SECONDARY: 'ARRVDS' };
  const categorizeNoteFailure = (result) => {
    if (!result || result.success !== false) return null;
    const ft = result.failureType;
    const status = result.statusCode;
    if (ft === 'UNREACHABLE' || ft === 'NOT_CONFIGURED') return 'network';
    if (typeof status === 'number') {
      if (status >= 500) return 'cad_5xx';
      if (status >= 400) return 'cad_4xx';
    }
    return 'cad_app_error';
  };
  return {
    RADIO_STATUS,
    extractActualStatusFromRejection: () => null,
    categorizeNoteFailure,
    isConfigured: vi.fn(() => true),
    updateUnitStatus: vi.fn(async () => ({ success: true })),
    addCallNote: vi.fn(async () => ({ success: true, note_id: 'NOTE-1' })),
    resolveUnitCurrentCall: vi.fn(async () => ({
      call_id: 'CALL-789',
      call_number: 'CALL-789',
      assigned_units: ['INDIANA-1'],
    })),
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
    setPrimaryUnitVerified: vi.fn(async () => ({ success: true })),
  };
});

vi.mock('../agencyKnowledge.js', () => ({
  resolveDestination: (text) => ({ kind: 'unique', place: { name: String(text).trim(), address: null } }),
  KNOWN_PLACES: [],
  setLearnedPlaces: vi.fn(),
}));

vi.mock('../dispatcherLearning.js', async () => {
  const actual = await vi.importActual('../dispatcherLearning.js');
  return {
    ...actual,
    recordCandidate: vi.fn(async () => ({ ok: true, candidateId: 1 })),
    refreshRuntimeIndex: vi.fn(async () => ({
      places: [],
      callsigns: new Map(),
      phrasings: new Map(),
      tenCodes: new Map(),
    })),
    invalidateCache: vi.fn(),
    getLearnedPlaces: vi.fn(async () => []),
  };
});

vi.mock('../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => 'CH-TEST',
  getAiSetting: async () => 'true',
  setAiSetting: async () => true,
  createChannelMessage: async () => null,
  getRecentAudioMessageBySender: async () => null,
}));

let AIDispatcher;
let cadService;
let llmIntentService;
let cm;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
  cadService = await import('../cadService.js');
  llmIntentService = await import('../llmIntentService.js');
});

function makeDispatcher() {
  const d = new AIDispatcher();
  d.connected = true;
  d.isRunning = true;
  d.channelName = 'CH-TEST';
  d.spoken = [];
  d.exchanges = [];
  d.logged = [];
  d.speak = async (text) => { d.spoken.push(text); };
  d.addConversationExchange = (uid, t, r) => { d.exchanges.push({ uid, t, r }); };
  const realLog = d.log.bind(d);
  d.log = (action, details = {}) => { d.logged.push({ action, details }); realLog(action, details); };
  return d;
}

function loggedAction(d, action) {
  return d.logged.find((e) => e.action === action);
}

function loggedActions(d, action) {
  return d.logged.filter((e) => e.action === action);
}

// -----------------------------------------------------------------------------
// Section 1 — _isCategoryCAreaClearTranscript classifier
// -----------------------------------------------------------------------------
describe('Task #538 classifier: Category C area-clear detection', () => {
  let d;
  beforeEach(() => { d = makeDispatcher(); });

  const CATEGORY_C_TRUE = [
    // Documented Category C phrasings — bare
    'first floor check complete',
    'second floor clear',
    'perimeter check complete',
    'back yard clear',
    'vehicle check complete',
    'checks complete',
    'building check complete',
    'interior clear',
    'exterior clear',
    'all checks complete',
    // With trailing also/as well/too
    'second floor clear also',
    'back yard clear as well',
    'interior clear too',
    'perimeter check complete also',
    // With leading "be advised"
    'be advised, the inside perimeter is clear',
    'be advised, the second floor is clear',
    'be advised, perimeter check complete',
    // Combined: be-advised + also (the original failing case)
    'be advised, the inside perimeter is clear also',
    // "I said" repeat hails
    'I said be advised, the inside perimeter is clear also',
    'I said perimeter clear',
    'I said be advised, perimeter check complete',
    // Free-form be-advised with substantive content
    'be advised the suspect left westbound on Main',
    'for the record the homeowner refused entry',
  ];

  it.each(CATEGORY_C_TRUE)('treats %p as Category C', (phrase) => {
    expect(d._isCategoryCAreaClearTranscript(phrase)).toBe(true);
  });

  const CATEGORY_C_FALSE = [
    // Pure acks must NOT trigger Category C
    '10-4',
    '10 4',
    'ten four',
    'copy',
    'copy that',
    'roger',
    'roger that',
    '10-4 copy',
    'copy 10-4',
    // Empty / whitespace
    '',
    '   ',
    // Generic chatter without an area noun + clear/check phrase
    'show me 10-8',
    'I am out at the post office',
    'radio check',
    'time check',
    'be advised', // bare trigger with no content
    // "clear (also|too|as well)" without an area noun must NOT trigger
    // the safety net — these are clear-unit / status semantics, not a note.
    "I'm clear too",
    "we're clear as well",
    'all clear too',
    'clear also',
  ];

  it.each(CATEGORY_C_FALSE)('does NOT treat %p as Category C', (phrase) => {
    expect(d._isCategoryCAreaClearTranscript(phrase)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Section 2 — Safety net: overrides bad LLM intents and routes to be-advised
// -----------------------------------------------------------------------------
describe('Task #538 safety net: overrides wrong LLM intents for Category C', () => {
  it('overrides SILENCE for "be advised, the inside perimeter is clear also"', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({ intent: 'SILENCE' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('be advised, the inside perimeter is clear also', 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeTruthy();
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    const [callId, noteText] = cadService.addCallNote.mock.calls[0];
    expect(callId).toBe('CALL-789');
    expect(String(noteText)).toContain('INDIANA-1:');
    // Final spoken response should be the "10-4" ack since the note was logged.
    expect(d.spoken.join(' ')).toContain('10-4');
  });

  it('overrides DISREGARD ("10-4, disregard") for "I said be advised, the inside perimeter is clear also"', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({
      intent: 'DISREGARD', response: '10-4, disregard.', slots: {},
    });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('I said be advised, the inside perimeter is clear also', 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeTruthy();
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).not.toContain('disregard');
    expect(said).toContain('10-4');
  });

  it('overrides STATUS_CHANGE for "perimeter clear"', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({
      intent: 'STATUS_CHANGE', response: 'Copy, in service, fourteen thirty.',
      cadStatus: 'available', slots: {},
    });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('perimeter clear', 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeTruthy();
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    expect(cadService.updateUnitStatus).not.toHaveBeenCalled();
  });

  it('preserves ADD_NOTE intent (no double-routing) for Category C', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({
      intent: 'ADD_NOTE', response: null,
      slots: { beAdvised: true, noteContent: 'be advised the inside perimeter is clear also' },
    });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('be advised, the inside perimeter is clear also', 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeFalsy();
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
  });

  it('does NOT override pure ack "10-4" — SILENCE stays SILENCE', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({ intent: 'SILENCE' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('10-4', 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeFalsy();
    expect(cadService.addCallNote).not.toHaveBeenCalled();
    expect(loggedAction(d, 'LLM_SILENCE')).toBeTruthy();
  });

  it('does NOT override pure ack "copy" — SILENCE stays SILENCE', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({ intent: 'SILENCE' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('copy', 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeFalsy();
    expect(cadService.addCallNote).not.toHaveBeenCalled();
  });

  it('does NOT override SILENCE for "I\'m clear too" (no area noun, not a note)', async () => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({ intent: 'SILENCE' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM("I'm clear too", 'INDIANA-1');
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeFalsy();
    expect(cadService.addCallNote).not.toHaveBeenCalled();
  });

  it('does NOT override CLEAR_UNIT (semantically distinct command)', async () => {
    // "I'm clear" classified as CLEAR_UNIT should NOT be hijacked to a note.
    llmIntentService.classifyIntent.mockResolvedValueOnce({
      intent: 'CLEAR_UNIT', response: null, slots: {},
    });
    const d = makeDispatcher();
    // We can't easily verify the full CLEAR_UNIT path here without more
    // mocks, but we can verify the safety net does NOT trigger.
    try {
      await d.processTranscriptWithLLM("interior clear", 'INDIANA-1');
    } catch (_) {}
    expect(loggedAction(d, 'BE_ADVISED_SAFETY_NET_TRIGGERED')).toBeFalsy();
  });
});

// -----------------------------------------------------------------------------
// Section 3 — Failure paths: every non-success exit must log
// BE_ADVISED_NOTE_DROPPED and must NOT speak a bare "10-4".
// -----------------------------------------------------------------------------
describe('Task #538 failure paths: never bare "10-4" without a note', () => {
  it('CAD unconfigured → spoken "CAD system not available", logs BE_ADVISED_NOTE_DROPPED', async () => {
    cadService.isConfigured.mockReturnValueOnce(false);
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised perimeter clear', 'be advised perimeter clear');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('cad system not available');
    expect(d.spoken.some((s) => /^INDIANA-1, 10-4\.?$/i.test(String(s).trim()))).toBe(false);
    const dropped = loggedAction(d, 'BE_ADVISED_NOTE_DROPPED');
    expect(dropped).toBeTruthy();
    expect(dropped.details.reason).toBe('cad_not_configured');
    expect(dropped.details.callId).toBe(null);
  });

  it('no active call → spoken "not assigned to a call", logs BE_ADVISED_NOTE_DROPPED', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-9', 'perimeter clear', 'perimeter clear');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('not assigned to a call');
    expect(d.spoken.some((s) => /^INDIANA-9, 10-4\.?$/i.test(String(s).trim()))).toBe(false);
    const dropped = loggedAction(d, 'BE_ADVISED_NOTE_DROPPED');
    expect(dropped).toBeTruthy();
    expect(dropped.details.reason).toBe('no_active_call');
  });

  it('CAD note write fails → spoken "unable to add note", logs BE_ADVISED_NOTE_DROPPED with category', async () => {
    cadService.addCallNote.mockResolvedValueOnce({
      success: false, statusCode: 500,
      failureCategory: 'cad_5xx', cadMessage: 'upstream down',
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised perimeter clear', 'be advised perimeter clear');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('unable to add note');
    expect(d.spoken.some((s) => /^INDIANA-1, 10-4\.?$/i.test(String(s).trim()))).toBe(false);
    const dropped = loggedAction(d, 'BE_ADVISED_NOTE_DROPPED');
    expect(dropped).toBeTruthy();
    expect(dropped.details.reason).toBe('cad_write_failed');
    expect(dropped.details.category).toBe('cad_5xx');
    expect(dropped.details.callId).toBe('CALL-789');
  });

  it('addCallNote throws → spoken "unable to add note", logs BE_ADVISED_NOTE_DROPPED', async () => {
    cadService.addCallNote.mockRejectedValueOnce(new Error('connection refused'));
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised perimeter clear', 'be advised perimeter clear');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('unable to add note');
    const dropped = loggedAction(d, 'BE_ADVISED_NOTE_DROPPED');
    expect(dropped).toBeTruthy();
    expect(dropped.details.reason).toBe('add_call_note_threw');
  });

  it('safety-net source is recorded in BE_ADVISED_NOTE_DROPPED', async () => {
    cadService.resolveUnitCurrentCall.mockResolvedValueOnce(null);
    llmIntentService.classifyIntent.mockResolvedValueOnce({ intent: 'SILENCE' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM('be advised, the inside perimeter is clear also', 'INDIANA-9');
    const dropped = loggedAction(d, 'BE_ADVISED_NOTE_DROPPED');
    expect(dropped).toBeTruthy();
    expect(dropped.details.source).toBe('safety_net');
    expect(dropped.details.llmIntent).toBe('SILENCE');
  });
});

// -----------------------------------------------------------------------------
// Section 4 — Soft rewrite-confidence guard
// -----------------------------------------------------------------------------
describe('Task #538 soft rewrite confidence guard', () => {
  it('low-confidence rewrite falls back to raw transcript verbatim instead of asking to repeat', async () => {
    llmIntentService.rewriteCallNote.mockResolvedValueOnce({
      note: '', confidence: 'low', rewritten: false,
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised, the inside perimeter is clear also', 'be advised, the inside perimeter is clear also');
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    const [, noteText] = cadService.addCallNote.mock.calls[0];
    expect(String(noteText)).toContain('INDIANA-1:');
    expect(String(noteText)).toContain('inside perimeter is clear');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('10-4');
    expect(said).not.toContain("didn't catch that note");
    expect(loggedAction(d, 'BE_ADVISED_REWRITE_FALLBACK')).toBeTruthy();
  });

  it('low-confidence + empty raw → still asks to repeat (no silent drop)', async () => {
    llmIntentService.rewriteCallNote.mockResolvedValueOnce({
      note: '', confidence: 'low', rewritten: false,
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', '', '');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain("didn't catch");
    expect(loggedAction(d, 'BE_ADVISED_NOTE_DROPPED')?.details?.reason).toBe('empty_transcript');
  });

  it('rewrite throws → falls back to raw and still writes the note', async () => {
    llmIntentService.rewriteCallNote.mockRejectedValueOnce(new Error('llm timeout'));
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'second floor clear also', 'second floor clear also');
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    expect(d.spoken.join(' ')).toContain('10-4');
    expect(loggedAction(d, 'BE_ADVISED_REWRITE_ERROR')).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// Section 5 — End-to-end Category C phrasing matrix via the safety net
// -----------------------------------------------------------------------------
describe('Task #538 E2E: Category C phrasings always reach addCallNote', () => {
  const PHRASES = [
    'first floor check complete',
    'second floor clear',
    'perimeter check complete',
    'back yard clear',
    'vehicle check complete',
    'checks complete',
    'building check complete',
    'interior clear',
    'exterior clear',
    'all checks complete',
    'be advised, first floor check complete',
    'be advised, second floor clear',
    'be advised, perimeter check complete',
    'be advised, back yard clear',
    'be advised, interior clear',
    'second floor clear also',
    'back yard clear as well',
    'interior clear too',
    'be advised, the inside perimeter is clear also',
    'I said be advised, the inside perimeter is clear also',
    'I said perimeter clear',
    'I said second floor clear too',
  ];

  it.each(PHRASES)('logs note for %p when LLM returns SILENCE', async (phrase) => {
    llmIntentService.classifyIntent.mockResolvedValueOnce({ intent: 'SILENCE' });
    const d = makeDispatcher();
    await d.processTranscriptWithLLM(phrase, 'INDIANA-1');
    expect(cadService.addCallNote).toHaveBeenCalledTimes(1);
    expect(d.spoken.join(' ')).toContain('10-4');
  });
});
