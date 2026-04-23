// Task #502: AI dispatcher consumes structured CAD note failures and:
//   * logs ONE rich CAD_NOTE_FAILED event with category, cadMessage,
//     callId, unit, noteLength, and code path,
//   * mirrors the failure into the dispatcher channel log,
//   * speaks a refusal that names the failure category in plain language.
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
  // Inline copy of categorizeNoteFailure so the dispatcher's defensive
  // `cadService.categorizeNoteFailure(...)` fallback works under the mock.
  const categorizeNoteFailure = (result) => {
    if (!result || result.success !== false) return null;
    const ft = result.failureType;
    const status = result.statusCode;
    const errMsg = String(result.error || '').toLowerCase();
    if (ft === 'UNREACHABLE' || ft === 'NOT_CONFIGURED') {
      if (errMsg.includes('timeout') || errMsg.includes('timed out')) return 'timeout';
      return 'network';
    }
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

vi.mock('../../db/index.js', () => ({
  default: {},
  isAiDispatchEnabled: async () => true,
  getAiDispatchChannel: async () => 'CH-TEST',
  getAiSetting: async () => 'true',
  setAiSetting: async () => true,
  createChannelMessage: async (...args) => {
    if (!globalThis.__task502_ccm_calls) globalThis.__task502_ccm_calls = [];
    globalThis.__task502_ccm_calls.push(args);
    return null;
  },
  getRecentAudioMessageBySender: async () => null,
}));

let AIDispatcher;
let cadService;
let cm;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  globalThis.__task502_ccm_calls = [];
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
  d.exchanges = [];
  d.logged = [];
  d.speak = async (text) => { d.spoken.push(text); };
  d.addConversationExchange = (uid, t, r) => { d.exchanges.push({ uid, t, r }); };
  const realLog = d.log.bind(d);
  d.log = (action, details = {}) => { d.logged.push({ action, details }); realLog(action, details); };
  return d;
}

function findFail(d) {
  return d.logged.find((e) => e.action === 'CAD_NOTE_FAILED');
}

function findMirroredText(re) {
  const calls = globalThis.__task502_ccm_calls || [];
  return calls.find((c) => re.test(String(c[3] || '')));
}

describe('Task #502: be_advised note failure', () => {
  it('cad_app_error → speaks "CAD rejected", logs rich event, mirrors raw CAD error', async () => {
    cadService.addCallNote.mockResolvedValueOnce({
      success: false, statusCode: 200,
      failureCategory: 'cad_app_error',
      cadMessage: 'Call already closed',
      error: 'Call already closed',
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised perimeter clear', 'be advised perimeter clear');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('unable to add note');
    expect(said).toContain('cad rejected');

    const fail = findFail(d);
    expect(fail).toBeTruthy();
    expect(fail.details.path).toBe('be_advised');
    expect(fail.details.category).toBe('cad_app_error');
    expect(fail.details.callId).toBe('CALL-789');
    expect(fail.details.unitId).toBe('INDIANA-1');
    expect(fail.details.cadMessage).toMatch(/Call already closed/);
    expect(fail.details.noteLength).toBeGreaterThan(0);

    expect(findMirroredText(/Call already closed/)).toBeTruthy();
    expect(findMirroredText(/CAD rejected/)).toBeTruthy();
  });

  it('cad_5xx → speaks "CAD unreachable"', async () => {
    cadService.addCallNote.mockResolvedValueOnce({
      success: false, statusCode: 503,
      failureCategory: 'cad_5xx', cadMessage: 'upstream down', error: 'upstream down',
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised', 'be advised');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('unable to add note');
    expect(said).toContain('cad unreachable');
    expect(findFail(d).details.category).toBe('cad_5xx');
  });
});

describe('Task #502: plain ADD_NOTE failure', () => {
  it('cad_4xx → speaks "CAD rejected" + logs path=add_note', async () => {
    cadService.addCallNote.mockResolvedValueOnce({
      success: false, statusCode: 422,
      failureCategory: 'cad_4xx', cadMessage: 'note too long', error: 'note too long',
    });
    const d = makeDispatcher();
    await d.executeAddNote('INDIANA-1', 'add note ten cars on scene', 'ten cars on scene');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('unable to add note');
    expect(said).toContain('cad rejected');
    const fail = findFail(d);
    expect(fail.details.path).toBe('add_note');
    expect(fail.details.category).toBe('cad_4xx');
    expect(fail.details.cadMessage).toMatch(/note too long/);
  });

  it('falls back to category="cad_app_error" when CAD only returns {success:false}', async () => {
    cadService.addCallNote.mockResolvedValueOnce({ success: false });
    const d = makeDispatcher();
    await d.executeAddNote('INDIANA-1', 'add note', 'a quick note');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('cad rejected');
    expect(findFail(d).details.category).toBe('cad_app_error');
  });
});

describe('Task #502: event note failure', () => {
  it('event_note cad_5xx → speaks "CAD unreachable" + logs + mirrors', async () => {
    cadService.addCallNote.mockResolvedValueOnce({
      success: false, statusCode: 502,
      failureCategory: 'cad_5xx', cadMessage: 'bad gateway', error: 'bad gateway',
    });
    const d = makeDispatcher();
    // CUSTODY is not a clear-air event so the handler doesn't go down the
    // signaling/clear-air path during this test.
    await d.executeLogEventNote('INDIANA-1', 'one in custody', { eventType: 'CUSTODY', entries: ['male white'] });
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('unable to log note');
    expect(said).toContain('cad unreachable');
    const fail = findFail(d);
    expect(fail).toBeTruthy();
    expect(fail.details.path).toBe('event_note');
    expect(fail.details.category).toBe('cad_5xx');
    expect(findMirroredText(/bad gateway/)).toBeTruthy();
  });
});

describe('Task #502: retry-then-success behavior at the dispatcher boundary', () => {
  it('a transient failure followed by a fresh attempt that succeeds yields the normal 10-4 ack', async () => {
    let n = 0;
    cadService.addCallNote.mockImplementation(async () => {
      n++;
      if (n === 1) {
        return {
          success: false, statusCode: 503,
          failureCategory: 'cad_5xx', cadMessage: 'overloaded',
          error: 'overloaded', attempt: 1,
        };
      }
      return { success: true, note_id: 'N-2' };
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised perimeter clear', 'be advised perimeter clear');
    expect(d.spoken.join(' ').toLowerCase()).toContain('cad unreachable');
    d.spoken.length = 0;
    await d.executeBeAdvisedNote('INDIANA-1', 'be advised perimeter clear', 'be advised perimeter clear');
    expect(d.spoken.join(' ')).toContain('10-4');
  });
});
