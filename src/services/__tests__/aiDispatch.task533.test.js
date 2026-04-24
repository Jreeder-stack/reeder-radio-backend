// Task #533 regression tests:
//   1) `has_warrants: true` (or warrant_count > 0) routes to secure-confirm,
//      not "no wants or warrants".
//   2) `alerts` / `caution_indicators` populated also routes to flagged.
//   3) A truly clean record still produces "no wants or warrants".
//   4) A single non-matching result is surfaced as a near-match for
//      confirmation, not spoken as a confirmed local-file hit.
//   5) A CAD-returned UTC DOB near a date boundary is spoken in the
//      dispatcher's local date, not the UTC date.
//   6) The secure-confirm read-back uses the CAD record's UTC->local DOB,
//      not the queried session DOB.
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

let cadQueryPersonImpl = vi.fn(async () => ({ success: true, results: [] }));

vi.mock('../cadService.js', () => ({
  RADIO_STATUS: {},
  extractActualStatusFromRejection: () => null,
  isConfigured: () => true,
  queryPerson: vi.fn((...args) => cadQueryPersonImpl(...args)),
  queryPersonByDL: vi.fn(async () => ({ success: true, results: [] })),
  queryPersonBySSN: vi.fn(async () => ({ success: true, results: [] })),
  queryWarrant: vi.fn(async () => ({ success: true, warrants: [] })),
  addCallNote: vi.fn(async () => ({ success: true })),
  resolveUnitCurrentCall: vi.fn(async () => null),
  rememberUnitUuid: vi.fn(),
  getCachedUnitUuid: vi.fn(() => null),
  updateUnitStatus: vi.fn(async () => ({ success: true })),
  getCallDetails: vi.fn(async () => ({ success: true, call: {} })),
  getActiveCalls: vi.fn(async () => ({ calls: [] })),
}));

vi.mock('../agencyKnowledge.js', () => ({
  resolveDestination: () => ({ kind: 'none' }),
  KNOWN_PLACES: [],
  setLearnedPlaces: vi.fn(),
}));

vi.mock('../dispatcherLearning.js', async () => {
  const actual = await vi.importActual('../dispatcherLearning.js');
  return {
    ...actual,
    recordCandidate: vi.fn(async () => ({ ok: true })),
    refreshRuntimeIndex: vi.fn(async () => ({
      places: [], callsigns: new Map(), phrasings: new Map(), tenCodes: new Map(),
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
}));

let AIDispatcher;
let cm;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cadQueryPersonImpl = vi.fn(async () => ({ success: true, results: [] }));
  cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
});

function makeDispatcher() {
  const d = new AIDispatcher();
  d.connected = true;
  d.isRunning = true;
  d.channelName = 'CH-TEST';
  d.spoken = [];
  d.speak = async (text) => { d.spoken.push(text); };
  d.addConversationExchange = () => {};
  d.logToCallNotes = async () => {};
  return d;
}

describe('Task #533: warrant flag detection across API field schemas', () => {
  it('treats has_warrants:true + warrant_count:1 as flagged (the incident payload)', async () => {
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1980-05-15T12:00:00Z',
        has_warrants: true,
        warrant_count: 1,
        alerts: [],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1980-05-15');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('mic secure');
    expect(said).not.toContain('no wants or warrants');
  });

  it('treats populated alerts as flagged even with no warrant fields', async () => {
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1980-05-15T12:00:00Z',
        has_warrants: false,
        warrant_count: 0,
        alerts: [{ description: 'mental health alert' }],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1980-05-15');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('mic secure');
    expect(said).not.toContain('no wants or warrants');
  });

  it('treats populated caution_indicators as flagged', async () => {
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1980-05-15T12:00:00Z',
        has_warrants: false,
        warrant_count: 0,
        alerts: [],
        caution_indicators: ['armed and dangerous'],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1980-05-15');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('mic secure');
    expect(said).not.toContain('no wants or warrants');
  });

  it('truly clean record still says "no wants or warrants"', async () => {
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1980-05-15T12:00:00Z',
        has_warrants: false,
        warrant_count: 0,
        alerts: [],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1980-05-15');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('no wants or warrants');
    expect(said).not.toContain('mic secure');
  });
});

describe('Task #533: exact-match guard on single result', () => {
  it('does not present a single non-matching first-name result as a confirmed hit', async () => {
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'STEVEN',
        last_name: 'SMITH',
        dob: '1980-05-15T12:00:00Z',
        has_warrants: false,
        alerts: [],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1980-05-15');
    const said = d.spoken.join(' ');
    expect(said.toLowerCase()).toContain('no exact match for jeffrey smith');
    expect(said).toContain('STEVEN SMITH');
    expect(said.toLowerCase()).toContain('advise which subject');
    expect(said.toLowerCase()).not.toContain('no wants or warrants');
    expect(said.toLowerCase()).not.toContain('mic secure');
  });

  it('does not present a single non-matching DOB result as a confirmed hit', async () => {
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1975-01-01T12:00:00Z',
        has_warrants: false,
        alerts: [],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1980-05-15');
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('no exact match for jeffrey smith');
    expect(said).toContain('advise which subject');
    expect(said).not.toContain('no wants or warrants');
  });
});

describe('Task #533: UTC->local DOB conversion for spoken read-back', () => {
  it('speaks the dispatcher local date when CAD returns a UTC DOB across the date boundary', async () => {
    // 1986-09-23 00:00:00Z is 1986-09-22 in America/New_York (UTC-4 in Sept).
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1986-09-23T00:00:00Z',
        has_warrants: true,
        warrant_count: 1,
        alerts: [],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    // Query against the LOCAL date so the exact-match guard does not fire.
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1986-09-22');

    // Confirm secure flow was entered (flagged).
    const stage1 = d.spoken.join(' ').toLowerCase();
    expect(stage1).toContain('mic secure');

    // Now run secure-confirm "yes". The read-back must use the local date
    // (September 22, 1986) — NOT September 23 (the UTC date).
    await d.handleSecureConfirmResponse('INDIANA-1', '10-4 mic is secure', cm.getUnitSessionState('INDIANA-1').slots);
    const said = d.spoken.join(' ');
    expect(said).toMatch(/September twenty second, nineteen eighty six/);
    expect(said).not.toMatch(/September twenty third, nineteen eighty six/);
  });

  it('stores the CAD record DOB (UTC->local) on the secure-confirm slot, not the raw returned UTC value', async () => {
    // CAD returns a UTC midnight DOB across the local date boundary. The
    // session slot the secure-confirm flow reads from must contain the
    // dispatcher-local "YYYY-MM-DD" form sourced from the CAD record,
    // never the raw "1986-09-23T00:00:00Z" / "1986-09-23" UTC string.
    // (When queried DOB == returned local DOB, the near-match guard does
    // not fire, so the flow reaches secure-confirm.)
    cadQueryPersonImpl = vi.fn(async () => ({
      success: true,
      count: 1,
      results: [{
        first_name: 'JEFFREY',
        last_name: 'SMITH',
        dob: '1986-09-23T00:00:00Z',
        has_warrants: true,
        warrant_count: 2,
        alerts: [],
        caution_indicators: [],
      }],
    }));
    const d = makeDispatcher();
    await d.executePersonCheck('INDIANA-1', 'SMITH', 'JEFFREY', '1986-09-22');
    const slots = cm.getUnitSessionState('INDIANA-1').slots;
    // Slot DOB must be the CAD record's local-converted DOB — and crucially
    // not any UTC-day variant of the returned value.
    expect(slots.dob).toBe('1986-09-22');
    expect(slots.dob).not.toBe('1986-09-23');
    expect(slots.dob).not.toContain('T');
    expect(slots.dob).not.toContain('Z');
    await d.handleSecureConfirmResponse('INDIANA-1', '10-4', slots);
    const said = d.spoken.join(' ');
    expect(said).toMatch(/September twenty second, nineteen eighty six/);
    expect(said).not.toMatch(/September twenty third/);
    expect(said.toLowerCase()).toContain('2 active warrants');
  });
});

describe('Task #533: helper unit tests', () => {
  it('_extractWarrantInfo flags has_warrants:true with warrant_count', async () => {
    const d = makeDispatcher();
    const info = d._extractWarrantInfo({ has_warrants: true, warrant_count: 1, alerts: [], caution_indicators: [] });
    expect(info.hasFlags).toBe(true);
    expect(info.warrantCount).toBe(1);
    expect(info.details.join(' ')).toMatch(/1 active warrant/);
  });

  it('_extractWarrantInfo returns hasFlags=false on a clean record', async () => {
    const d = makeDispatcher();
    const info = d._extractWarrantInfo({ has_warrants: false, warrant_count: 0, alerts: [], caution_indicators: [] });
    expect(info.hasFlags).toBe(false);
    expect(info.details.length).toBe(0);
  });

  it('_speakDobFromCadRecord converts UTC midnight across the local date boundary', async () => {
    const d = makeDispatcher();
    const out = d._speakDobFromCadRecord('1986-09-23T00:00:00Z');
    expect(out.local).toBe('1986-09-22');
    expect(out.spoken).toMatch(/September twenty second/);
  });
});
