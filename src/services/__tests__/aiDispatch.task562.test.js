// Task #562: AI call creation must read calls back like a normal dispatcher
// (no "10-4 or negative?" coaching) and must default a stateless address to
// Pennsylvania before geocoding so a same-named street in another state
// can't win the geocoder match.
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

vi.mock('../locationService.js', () => ({
  default: {
    forwardGeocode: vi.fn(async () => null),
  },
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
    createCall: vi.fn(async () => ({ success: true, call_id: 'CALL-NEW', call_number: 'CALL-NEW' })),
    findBestNature: vi.fn(async (n) => String(n).toUpperCase()),
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
let locationService;
let cm;
let helpers;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  helpers = await import('../aiDispatchService.js');
  AIDispatcher = helpers.AIDispatcher;
  cadService = await import('../cadService.js');
  locationService = (await import('../locationService.js')).default;
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

describe('Task #562: addressContainsUsState helper', () => {
  it('returns false for stateless street addresses', () => {
    expect(helpers.addressContainsUsState('1700 Main Street')).toBe(false);
    expect(helpers.addressContainsUsState('1700 Main Street, Pittsburgh')).toBe(false);
  });

  it('returns false for stateless intersections', () => {
    expect(helpers.addressContainsUsState('5th & Main')).toBe(false);
    expect(helpers.addressContainsUsState('5th & Main, Pittsburgh')).toBe(false);
  });

  it('detects a 2-letter trailing state abbreviation', () => {
    expect(helpers.addressContainsUsState('1700 Main Street, Pittsburgh, PA')).toBe(true);
    expect(helpers.addressContainsUsState('1700 Main Street, Pittsburgh, pa')).toBe(true);
    expect(helpers.addressContainsUsState('1700 Main Street, Indianapolis, IN 46204')).toBe(true);
  });

  it('detects a full state name as a trailing comma-separated token', () => {
    expect(helpers.addressContainsUsState('1700 Main Street, Pittsburgh, Pennsylvania')).toBe(true);
    expect(helpers.addressContainsUsState('1700 Main Street, Indianapolis, Indiana')).toBe(true);
  });

  it('detects a trailing state name without a comma', () => {
    expect(helpers.addressContainsUsState('1700 Main Street Pennsylvania')).toBe(true);
  });

  it('does not false-positive on a street named after a state', () => {
    expect(helpers.addressContainsUsState('1700 Washington Avenue')).toBe(false);
    expect(helpers.addressContainsUsState('1700 Washington Avenue, Pittsburgh')).toBe(false);
  });

  it('returns false for empty/garbage input', () => {
    expect(helpers.addressContainsUsState('')).toBe(false);
    expect(helpers.addressContainsUsState(null)).toBe(false);
    expect(helpers.addressContainsUsState(undefined)).toBe(false);
  });
});

describe('Task #562: applyDefaultStateToAddress helper', () => {
  it('appends ", PA" to a stateless house-numbered street address', () => {
    expect(helpers.applyDefaultStateToAddress('1700 Main Street'))
      .toBe('1700 Main Street, PA');
  });

  it('appends ", PA" to a stateless intersection', () => {
    expect(helpers.applyDefaultStateToAddress('5th & Main'))
      .toBe('5th & Main, PA');
  });

  it('appends ", PA" to a stateless street + city', () => {
    expect(helpers.applyDefaultStateToAddress('1700 Main Street, Pittsburgh'))
      .toBe('1700 Main Street, Pittsburgh, PA');
  });

  it('leaves an address that already has PA alone', () => {
    expect(helpers.applyDefaultStateToAddress('1700 Main Street, Pittsburgh, PA'))
      .toBe('1700 Main Street, Pittsburgh, PA');
    expect(helpers.applyDefaultStateToAddress('1700 Main Street, Pittsburgh, Pennsylvania'))
      .toBe('1700 Main Street, Pittsburgh, Pennsylvania');
  });

  it('leaves an address that already has another state alone', () => {
    expect(helpers.applyDefaultStateToAddress('1700 Main Street, Indianapolis, IN'))
      .toBe('1700 Main Street, Indianapolis, IN');
    expect(helpers.applyDefaultStateToAddress('1700 Main Street, Indianapolis, Indiana'))
      .toBe('1700 Main Street, Indianapolis, Indiana');
  });

  it('strips trailing whitespace/comma before appending', () => {
    expect(helpers.applyDefaultStateToAddress('1700 Main Street,  '))
      .toBe('1700 Main Street, PA');
  });

  it('respects a custom default state abbreviation', () => {
    expect(helpers.applyDefaultStateToAddress('1700 Main Street', 'OH'))
      .toBe('1700 Main Street, OH');
  });

  it('returns the input unchanged for empty/garbage input', () => {
    expect(helpers.applyDefaultStateToAddress('')).toBe('');
    expect(helpers.applyDefaultStateToAddress(null)).toBe(null);
  });
});

describe('Task #562: _verifyAddressForCall biases stateless addresses to PA', () => {
  it('appends ", PA" before geocoding when no state is provided (create context)', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '1700 Main Street, Pittsburgh, PA, USA',
      lat: 40.44, lng: -79.99,
      houseNumber: '1700', road: 'Main Street',
      city: 'Pittsburgh', state: 'Pennsylvania',
      importance: 0.6,
    });
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('1700 main street');
    expect(locationService.forwardGeocode).toHaveBeenCalledWith('1700 main street, PA');
    expect(v.verified).toBe(true);
    expect(v.canonical).toBe('1700 Main Street, Pittsburgh, PA');
    expect(d.logs.some(l => l.event === 'GEOCODE_DEFAULT_STATE_APPLIED')).toBe(true);
  });

  it('does NOT append a state when the address already has one', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '1700 Main Street, Indianapolis, IN, USA',
      lat: 39.77, lng: -86.15,
      houseNumber: '1700', road: 'Main Street',
      city: 'Indianapolis', state: 'Indiana',
      importance: 0.6,
    });
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('1700 main street, Indianapolis, IN');
    expect(locationService.forwardGeocode).toHaveBeenCalledWith('1700 main street, Indianapolis, IN');
    expect(v.verified).toBe(true);
    expect(d.logs.some(l => l.event === 'GEOCODE_DEFAULT_STATE_APPLIED')).toBe(false);
  });

  it('does NOT append a state when the update flow runs (out of scope)', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d._verifyAddressForCall('1700 main street', { context: 'update' });
    expect(locationService.forwardGeocode).toHaveBeenCalledWith('1700 main street');
    expect(d.logs.some(l => l.event === 'GEOCODE_DEFAULT_STATE_APPLIED')).toBe(false);
  });

  it('a stateless PA address resolves to the PA result instead of a same-named street elsewhere', async () => {
    // Simulates the geocoder behaviour we want: with the PA default
    // appended, Nominatim returns the Pittsburgh, PA match — never the
    // Indianapolis, IN match. The mock asserts the queried string carries
    // the PA bias and only then returns the PA hit.
    locationService.forwardGeocode.mockImplementationOnce(async (q) => {
      if (!/,\s*PA\b/i.test(q)) return null;
      return {
        displayName: '1700 Main Street, Pittsburgh, PA, USA',
        lat: 40.44, lng: -79.99,
        houseNumber: '1700', road: 'Main Street',
        city: 'Pittsburgh', state: 'Pennsylvania',
        importance: 0.6,
      };
    });
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('1700 main street');
    expect(v.verified).toBe(true);
    expect(v.canonical).toBe('1700 Main Street, Pittsburgh, PA');
    expect(v.lat).toBeCloseTo(40.44);
    expect(v.lng).toBeCloseTo(-79.99);
  });
});

describe('Task #562: natural call-creation readback prompts', () => {
  it('verified-address readback contains the call but not "10-4?" or "10-4 or negative"', async () => {
    locationService.forwardGeocode.mockResolvedValue({
      displayName: '1700 Main Street, Pittsburgh, PA, USA',
      lat: 40.44, lng: -79.99,
      houseNumber: '1700', road: 'Main Street',
      city: 'Pittsburgh', state: 'Pennsylvania',
      importance: 0.6,
    });
    // Run multiple times so the random template rotation is exercised.
    for (let i = 0; i < 10; i++) {
      const d = makeDispatcher();
      await d.handleCallAddressInput('INDIANA-1', '1700 main street', {
        nature: 'TRAFFIC STOP', additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
      });
      const prompt = d.spoken[d.spoken.length - 1];
      expect(prompt).toContain('INDIANA-1');
      expect(prompt.toLowerCase()).toContain('traffic stop');
      expect(prompt).toContain('1700 Main Street, Pittsburgh, PA');
      expect(prompt).not.toMatch(/10-4\?/);
      expect(prompt).not.toMatch(/10-4 or negative/i);
      expect(prompt).not.toMatch(/I couldn't verify/);
      expect(prompt).not.toMatch(/^.*confirm,/);
    }
  });

  it('unverified-address readback warns "I couldn\'t verify ADDR" and never coaches "10-4 or negative"', async () => {
    locationService.forwardGeocode.mockResolvedValue(null);
    for (let i = 0; i < 10; i++) {
      const d = makeDispatcher();
      await d.handleCallAddressInput('INDIANA-1', '99999 nowhere blvd', {
        nature: 'TRAFFIC STOP', additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
      });
      const prompt = d.spoken[d.spoken.length - 1];
      expect(prompt).toContain('INDIANA-1');
      expect(prompt).toMatch(/I couldn't verify 99999 nowhere blvd/);
      expect(prompt).not.toMatch(/10-4\?/);
      expect(prompt).not.toMatch(/10-4 or negative/i);
    }
  });

  it('re-prompt on neither-confirm-nor-deny does NOT say "10-4 or negative"', async () => {
    for (let i = 0; i < 10; i++) {
      const d = makeDispatcher();
      // Drop the unit straight into AWAITING_CALL_CONFIRM with mild input.
      const slots = {
        nature: 'TRAFFIC STOP',
        address: '1700 Main Street, Pittsburgh, PA',
        addressUnverified: false,
        addressLat: 40.44, addressLng: -79.99,
        additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
      };
      await d.handleCallConfirm('INDIANA-1', 'uh, what was that', slots);
      const prompt = d.spoken[d.spoken.length - 1];
      expect(prompt).toContain('INDIANA-1');
      expect(prompt).not.toMatch(/10-4\?/);
      expect(prompt).not.toMatch(/10-4 or negative/i);
      expect(prompt).not.toMatch(/confirm call/i);
    }
  });

  it('confirm-phrases ("10-4", "copy", "affirmative") still confirm the call after the new readback', async () => {
    locationService.forwardGeocode.mockResolvedValue({
      displayName: '1700 Main Street, Pittsburgh, PA, USA',
      lat: 40.44, lng: -79.99,
      houseNumber: '1700', road: 'Main Street',
      city: 'Pittsburgh', state: 'Pennsylvania',
      importance: 0.6,
    });
    for (const reply of ['10-4', 'copy', 'affirmative', 'roger that']) {
      vi.clearAllMocks();
      const d = makeDispatcher();
      await d.handleCallAddressInput('INDIANA-1', '1700 main street', {
        nature: 'TRAFFIC STOP', additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
      });
      const session = cm.getUnitSessionState('INDIANA-1');
      expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_CONFIRM);
      await d.handleCallConfirm('INDIANA-1', reply, session.slots);
      expect(cadService.createCall).toHaveBeenCalledTimes(1);
    }
  });

  it('deny-phrases ("negative", "wrong") still cancel the call after the new readback', async () => {
    locationService.forwardGeocode.mockResolvedValue({
      displayName: '1700 Main Street, Pittsburgh, PA, USA',
      lat: 40.44, lng: -79.99,
      houseNumber: '1700', road: 'Main Street',
      city: 'Pittsburgh', state: 'Pennsylvania',
      importance: 0.6,
    });
    for (const reply of ['negative', 'wrong', 'no']) {
      vi.clearAllMocks();
      const d = makeDispatcher();
      await d.handleCallAddressInput('INDIANA-1', '1700 main street', {
        nature: 'TRAFFIC STOP', additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
      });
      const session = cm.getUnitSessionState('INDIANA-1');
      await d.handleCallConfirm('INDIANA-1', reply, session.slots);
      expect(cadService.createCall).not.toHaveBeenCalled();
      const after = cm.getUnitSessionState('INDIANA-1');
      expect(after.state).toBe(cm.DISPATCHER_STATE.IDLE);
    }
  });
});

describe('Task #562: status-descriptor pivot-to-create uses the natural readback', () => {
  it('verified pivot readback omits "10-4 or negative?" and includes the nature/address', async () => {
    locationService.forwardGeocode.mockResolvedValue({
      displayName: '1700 Main Street, Pittsburgh, PA, USA',
      lat: 40.44, lng: -79.99,
      houseNumber: '1700', road: 'Main Street',
      city: 'Pittsburgh', state: 'Pennsylvania',
      importance: 0.6,
    });
    for (let i = 0; i < 6; i++) {
      const d = makeDispatcher();
      const took = await d._maybePivotDescriptorToCreate('INDIANA-1', 'show me en route on a domestic at 1700 main street', 'en_route', {
        callNature: 'domestic',
        callLocation: '1700 main street',
      });
      expect(took).toBe(true);
      const session = cm.getUnitSessionState('INDIANA-1');
      expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_CONFIRM);
      expect(session.slots.arrivalStatus).toBe('en_route');
      const prompt = d.spoken[d.spoken.length - 1];
      expect(prompt).toContain('INDIANA-1');
      expect(prompt.toLowerCase()).toContain('domestic');
      expect(prompt).toContain('1700 Main Street, Pittsburgh, PA');
      expect(prompt).not.toMatch(/10-4\?/);
      expect(prompt).not.toMatch(/10-4 or negative/i);
      expect(prompt).not.toMatch(/I couldn't verify/);
    }
  });

  it('unverified pivot readback warns "I couldn\'t verify ADDR" and never coaches "10-4 or negative"', async () => {
    locationService.forwardGeocode.mockResolvedValue(null);
    for (let i = 0; i < 6; i++) {
      const d = makeDispatcher();
      const took = await d._maybePivotDescriptorToCreate('INDIANA-1', 'show me on scene of a domestic at 99999 nowhere blvd', 'on_scene', {
        callNature: 'domestic',
        callLocation: '99999 nowhere blvd',
      });
      expect(took).toBe(true);
      const prompt = d.spoken[d.spoken.length - 1];
      expect(prompt).toContain('INDIANA-1');
      expect(prompt).toMatch(/I couldn't verify 99999 nowhere blvd/);
      expect(prompt).not.toMatch(/10-4\?/);
      expect(prompt).not.toMatch(/10-4 or negative/i);
    }
  });
});

describe('Task #562: buildCallConfirmReadback / buildCallConfirmReprompt template helpers', () => {
  it('all verified templates omit "10-4?" / "10-4 or negative" and include the call+address', () => {
    for (let i = 0; i < 30; i++) {
      const out = helpers.buildCallConfirmReadback('INDIANA-1', 'TRAFFIC STOP', '1700 Main Street, Pittsburgh, PA', false);
      expect(out).toContain('INDIANA-1');
      expect(out.toLowerCase()).toContain('traffic stop');
      expect(out).toContain('1700 Main Street, Pittsburgh, PA');
      expect(out).not.toMatch(/10-4\?/);
      expect(out).not.toMatch(/10-4 or negative/i);
    }
  });

  it('all unverified templates contain "I couldn\'t verify ADDR" and omit "10-4 or negative"', () => {
    for (let i = 0; i < 30; i++) {
      const out = helpers.buildCallConfirmReadback('INDIANA-1', 'TRAFFIC STOP', '99999 nowhere blvd', true);
      expect(out).toMatch(/I couldn't verify 99999 nowhere blvd/);
      expect(out).not.toMatch(/10-4 or negative/i);
    }
  });

  it('all reprompt templates avoid "10-4?" and "10-4 or negative"', () => {
    for (let i = 0; i < 30; i++) {
      const out = helpers.buildCallConfirmReprompt('INDIANA-1', 'TRAFFIC STOP', '1700 Main Street');
      expect(out).toContain('INDIANA-1');
      expect(out).not.toMatch(/10-4\?/);
      expect(out).not.toMatch(/10-4 or negative/i);
      expect(out).not.toMatch(/confirm call/i);
    }
  });

  it('rotates through more than one phrasing across many invocations (not robotic)', () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) {
      seen.add(helpers.buildCallConfirmReadback('INDIANA-1', 'TRAFFIC STOP', '1700 Main Street, Pittsburgh, PA', false));
      if (seen.size > 1) break;
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
