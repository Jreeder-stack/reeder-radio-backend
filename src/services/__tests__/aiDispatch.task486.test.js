// Task #486 regression tests:
//   1) Hourly time broadcast suppressed when live RX is on the air.
//   2) "Check complete"-style reports route to ADD_NOTE (be-advised).
//   3) Routine acknowledgments no longer leak the call number.
//   4) CALL_DETAILS responds per-field instead of dumping every field.
//   5) Raw backend IDs are scrubbed before TTS.
//   6) MAKE_PRIMARY routes to the primary-unit handler (no "no active call").
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
    getUnitCurrentCallById: vi.fn(async () => ({ call_id: 'CALL-789', call_number: 'CALL-789', assigned_units: ['INDIANA-1', 'INDIANA-2'] })),
    clearUnit: vi.fn(async () => ({ success: true })),
    disposeCall: vi.fn(async () => ({ success: true })),
    cancelCallDirect: vi.fn(async () => ({ success: true })),
    reopenCall: vi.fn(async () => ({ success: true })),
    getCallDetails: vi.fn(async (id) => ({
      success: true,
      call: {
        call_id: id,
        call_number: id,
        nature: 'Disturbance',
        location: '123 Main Street',
        priority: 'high',
        status: 'active',
        notes: 'Caller reports loud music',
        assigned_units: [
          { callsign: 'INDIANA-1', unit_id: 'unit_abcdef123456' },
          { callsign: 'INDIANA-2', unit_id: 'unit_zzzzzzzzzzzz' },
        ],
      },
    })),
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
  d.speak = async (text, _unit) => { d.spoken.push(text); };
  d.addConversationExchange = () => {};
  return d;
}

describe('Task #486 (Step 1): hourly broadcast suppressed by live RX', () => {
  it('hasRecentInbound flags non-AI traffic and skips broadcast', async () => {
    const { audioRelayService } = await import('../audioRelayService.js');
    audioRelayService._lastAudioReceived.clear();
    audioRelayService.trackAudioReceived('CH-TEST', 'INDIANA-1');
    const recent = audioRelayService.hasRecentInbound('CH-TEST', 5000, ['AI-Dispatcher']);
    expect(recent).toBeTruthy();
    expect(recent.unitId).toBe('INDIANA-1');
  });

  it('hasRecentInbound ignores excluded AI sender', async () => {
    const { audioRelayService } = await import('../audioRelayService.js');
    audioRelayService._lastAudioReceived.clear();
    audioRelayService.trackAudioReceived('CH-TEST', 'AI-Dispatcher');
    const recent = audioRelayService.hasRecentInbound('CH-TEST', 5000, ['AI-Dispatcher']);
    expect(recent).toBeNull();
  });

  it('hasRecentInbound respects withinMs window', async () => {
    const { audioRelayService } = await import('../audioRelayService.js');
    audioRelayService._lastAudioReceived.clear();
    audioRelayService._lastAudioReceived.set('CH-TEST::INDIANA-1', Date.now() - 60_000);
    const recent = audioRelayService.hasRecentInbound('CH-TEST', 2500, ['AI-Dispatcher']);
    expect(recent).toBeNull();
  });
});

describe('Task #486 (Step 3): routine ack drops call number', () => {
  it('en route ack does not contain the call number', async () => {
    const d = makeDispatcher();
    await d._executeCallVerb('INDIANA-1', '10-76 to call 789', { call_id: 'CALL-789', call_number: 'CALL-789' }, 'en_route');
    const said = d.spoken.join(' ');
    expect(said).not.toContain('CALL-789');
    expect(said.toLowerCase()).toContain('en route');
  });

  it('assign ack does not contain the call number', async () => {
    const d = makeDispatcher();
    await d._executeCallVerb('INDIANA-1', 'show me on call 789', { call_id: 'CALL-789', call_number: 'CALL-789' }, 'assign');
    const said = d.spoken.join(' ');
    expect(said).not.toContain('CALL-789');
    expect(said).toContain('10-4');
  });
});

describe('Task #486 (Step 4): per-field call details', () => {
  it('responds with only the address when asked', async () => {
    const d = makeDispatcher();
    await d.handleCallDetails('INDIANA-1', "what's the address on the call", { detailField: 'address' });
    const said = d.spoken.join(' ');
    expect(said).toContain('123 Main Street');
    expect(said.toLowerCase()).not.toContain('priority');
    expect(said.toLowerCase()).not.toContain('nature');
  });

  it('responds with only the priority when asked', async () => {
    const d = makeDispatcher();
    await d.handleCallDetails('INDIANA-1', "what's the priority", { detailField: 'priority' });
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).toContain('priority high');
    expect(said).not.toContain('main street');
  });

  it('falls back to transcript keywords when slot omitted', async () => {
    const d = makeDispatcher();
    await d.handleCallDetails('INDIANA-1', 'what is the address on the call', {});
    const said = d.spoken.join(' ');
    expect(said).toContain('123 Main Street');
  });

  it('full readout includes callsigns but never raw unit_<hex> ids', async () => {
    const d = makeDispatcher();
    await d.handleCallDetails('INDIANA-1', 'give me everything on the call', { detailField: 'all' });
    const said = d.spoken.join(' ');
    expect(said).toContain('INDIANA-1');
    expect(said).toContain('INDIANA-2');
    expect(said).not.toMatch(/unit_[0-9a-f]+/);
  });
});

describe('Task #486 (Step 5): TTS sanitizer scrubs backend IDs', () => {
  it('replaces UUIDs and unit_<hex> tokens with the word "unit"', () => {
    const d = makeDispatcher();
    const out = d._sanitizeForTts('Assigned to unit_deadbeefcafe and 11111111-2222-3333-4444-555555555555 now.');
    expect(out.replaced).toBe(2);
    expect(out.text).not.toMatch(/unit_[0-9a-f]+/);
    expect(out.text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('passes through clean strings unchanged', () => {
    const d = makeDispatcher();
    const out = d._sanitizeForTts('INDIANA-1, copy, en route, 14:32 hours.');
    expect(out.replaced).toBe(0);
    expect(out.text).toBe('INDIANA-1, copy, en route, 14:32 hours.');
  });

  it('_formatCallsignList strips raw IDs from mixed unit lists', () => {
    const d = makeDispatcher();
    const out = d._formatCallsignList([
      { callsign: 'INDIANA-1', unit_id: 'unit_aaaaaaaaaaaa' },
      'unit_bbbbbbbbbbbb',
      { callsign: 'INDIANA-2' },
    ]);
    expect(out).toContain('INDIANA-1');
    expect(out).toContain('INDIANA-2');
    expect(out).not.toMatch(/unit_[0-9a-f]+/);
  });
});

describe('Task #486 (Step 7): MAKE_PRIMARY handler', () => {
  it('resolves the speaker\'s shared call and promotes them via CAD', async () => {
    const d = makeDispatcher();
    await d.handleMakePrimary('INDIANA-2', 'make me primary', {});
    expect(cadService.setPrimaryUnit).toHaveBeenCalledWith('CALL-789', 'INDIANA-2');
    const said = d.spoken.join(' ');
    expect(said.toLowerCase()).toContain('primary');
    expect(said.toLowerCase()).not.toContain('no active call');
  });

  it('promotes another unit when the speaker names a target', async () => {
    const d = makeDispatcher();
    await d.handleMakePrimary('INDIANA-1', 'make Lincoln-3 primary on the call', { targetUnit: 'Lincoln-3' });
    expect(cadService.setPrimaryUnit).toHaveBeenCalledWith('CALL-789', 'LINCOLN-3');
    const said = d.spoken.join(' ');
    expect(said).toContain('LINCOLN-3');
    expect(said.toLowerCase()).toContain('primary');
  });

  it('routine primary ack does not echo the call number', async () => {
    const d = makeDispatcher();
    await d.handleMakePrimary('INDIANA-2', 'make me primary', {});
    const said = d.spoken.join(' ');
    expect(said).not.toContain('CALL-789');
    expect(said).not.toContain('789');
  });

  it('refuses cleanly when speaker has no current call', async () => {
    cadService.getUnitCurrentCallById.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.handleMakePrimary('INDIANA-3', 'make me primary', {});
    expect(cadService.setPrimaryUnit).not.toHaveBeenCalled();
    expect(d.spoken.join(' ').toLowerCase()).toContain("not on a call");
  });

  it('"make X primary" uses the SPEAKER\'s current call, never the target\'s', async () => {
    // Speaker (INDIANA-1) is on CALL-100. Target (LINCOLN-3) is on a
    // DIFFERENT call CALL-999. "Make Lincoln-3 primary [on this call]"
    // must promote LINCOLN-3 onto CALL-100 (speaker's), not CALL-999.
    // handleMakePrimary calls getUnitCurrentCallById ONCE — for the
    // speaker. mockResolvedValueOnce proves we never look up the target.
    cadService.getUnitCurrentCallById.mockResolvedValueOnce({
      call_id: 'CALL-100',
      call_number: 'CALL-100',
    });
    const d = makeDispatcher();
    await d.handleMakePrimary('INDIANA-1', 'make Lincoln-3 primary', { targetUnit: 'Lincoln-3' });
    expect(cadService.getUnitCurrentCallById).toHaveBeenCalledWith('INDIANA-1');
    expect(cadService.getUnitCurrentCallById).not.toHaveBeenCalledWith('LINCOLN-3');
    expect(cadService.setPrimaryUnit).toHaveBeenCalledWith('CALL-100', 'LINCOLN-3');
    expect(cadService.setPrimaryUnit).not.toHaveBeenCalledWith('CALL-999', expect.anything());
  });

  it('refuses when SPEAKER has no call, even if target is on one', async () => {
    cadService.getUnitCurrentCallById.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.handleMakePrimary('INDIANA-7', 'make Lincoln-3 primary', { targetUnit: 'Lincoln-3' });
    expect(cadService.getUnitCurrentCallById).toHaveBeenCalledWith('INDIANA-7');
    expect(cadService.setPrimaryUnit).not.toHaveBeenCalled();
    expect(d.spoken.join(' ').toLowerCase()).toContain("not on a call");
  });
});

describe('Task #486 (Step 2): "check complete" routes through ADD_NOTE/be-advised', () => {
  it('executeBeAdvisedNote rewrites and logs an area-clear report as a call note', async () => {
    const llm = await import('../llmIntentService.js');
    llm.rewriteCallNote.mockResolvedValueOnce({
      note: 'First floor checked, all clear.',
      confidence: 'high',
      rewritten: true,
    });
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-1', 'first floor check complete', 'first floor check complete');
    expect(cadService.addCallNote).toHaveBeenCalled();
    const [callId, noteText] = cadService.addCallNote.mock.calls[0];
    expect(callId).toBe('CALL-789');
    expect(String(noteText)).toContain('First floor');
    // The handler must NOT have spoken any clear/10-8 confirmation
    const said = d.spoken.join(' ').toLowerCase();
    expect(said).not.toContain('10-8');
    expect(said).not.toContain('clear from the call');
  });

  it('refuses cleanly when speaker is not on a call', async () => {
    cadService.getUnitCurrentCallById.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.executeBeAdvisedNote('INDIANA-9', 'perimeter clear', 'perimeter clear');
    expect(cadService.addCallNote).not.toHaveBeenCalled();
    expect(d.spoken.join(' ').toLowerCase()).toContain("not assigned to a call");
  });
});

describe('Task #486 (Step 6): status check watchdog', () => {
  it('synthesizes a status_check_due for an on-scene unit older than 22 minutes', async () => {
    const oldOnSceneAt = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    cadService.getActiveCalls.mockResolvedValueOnce({
      calls: [{
        call_id: 'CALL-200',
        call_number: 'CALL-200',
        assigned_units: [
          { callsign: 'INDIANA-7', status: 'on_scene', on_scene_at: oldOnSceneAt },
        ],
      }],
    });
    const d = makeDispatcher();
    const events = [];
    d._onCadStatusCheckEvent = async (evt) => { events.push(evt); };
    await d._runStatusCheckWatchdog();
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('status_check_due');
    expect(events[0].unitNumber).toBe('INDIANA-7');
    expect(events[0].callId).toBe('CALL-200');
    expect(events[0].raw?.source).toBe('watchdog');
  });

  it('does NOT fire when the on-scene timestamp is fresh', async () => {
    const recentOnSceneAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    cadService.getActiveCalls.mockResolvedValueOnce({
      calls: [{
        call_id: 'CALL-201',
        call_number: 'CALL-201',
        assigned_units: [
          { callsign: 'INDIANA-7', status: 'on_scene', on_scene_at: recentOnSceneAt },
        ],
      }],
    });
    const d = makeDispatcher();
    const events = [];
    d._onCadStatusCheckEvent = async (evt) => { events.push(evt); };
    await d._runStatusCheckWatchdog();
    expect(events.length).toBe(0);
  });

  it('skips when a status check is already pending for that unit/call', async () => {
    const oldOnSceneAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    cadService.getActiveCalls.mockResolvedValueOnce({
      calls: [{
        call_id: 'CALL-202',
        call_number: 'CALL-202',
        assigned_units: [
          { callsign: 'INDIANA-7', status: 'on_scene', on_scene_at: oldOnSceneAt },
        ],
      }],
    });
    const d = makeDispatcher();
    d._pendingStatusChecks.set(d._pendingStatusCheckKey('INDIANA-7', 'CALL-202'), { unitId: 'INDIANA-7', callId: 'CALL-202' });
    const events = [];
    d._onCadStatusCheckEvent = async (evt) => { events.push(evt); };
    await d._runStatusCheckWatchdog();
    expect(events.length).toBe(0);
  });

  it('cooldown prevents re-firing within five minutes', async () => {
    const oldOnSceneAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const callPayload = {
      calls: [{
        call_id: 'CALL-203',
        call_number: 'CALL-203',
        assigned_units: [
          { callsign: 'INDIANA-7', status: 'on_scene', on_scene_at: oldOnSceneAt },
        ],
      }],
    };
    cadService.getActiveCalls.mockResolvedValue(callPayload);
    const d = makeDispatcher();
    const events = [];
    d._onCadStatusCheckEvent = async (evt) => { events.push(evt); };
    await d._runStatusCheckWatchdog();
    await d._runStatusCheckWatchdog();
    expect(events.length).toBe(1);
  });

  it('skips raw backend IDs that lack a callsign', async () => {
    const oldOnSceneAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    cadService.getActiveCalls.mockResolvedValueOnce({
      calls: [{
        call_id: 'CALL-204',
        call_number: 'CALL-204',
        assigned_units: [
          { unit_id: 'unit_abcdef123456', status: 'on_scene', on_scene_at: oldOnSceneAt },
        ],
      }],
    });
    const d = makeDispatcher();
    const events = [];
    d._onCadStatusCheckEvent = async (evt) => { events.push(evt); };
    await d._runStatusCheckWatchdog();
    expect(events.length).toBe(0);
  });
});
