// Task #542: AI dispatcher must verify spoken call addresses against the
// geocoder, prefer the canonical spelling on read-back/CAD, and accept an
// `address` slot on UPDATE_CALL so addresses can be patched on existing
// calls (with the same verification + warn-on-miss behavior).
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
    getCallDetails: vi.fn(async (id) => ({ success: true, id, call_id: id, call: { call_id: id, call_number: id, location: 'OLD ADDR' } })),
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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  cm = await import('../commandMatcher.js');
  cm.resetDispatcherState();
  const mod = await import('../aiDispatchService.js');
  AIDispatcher = mod.AIDispatcher;
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

describe('Task #542: _verifyAddressForCall returns canonical spelling on confident geocoder hit', () => {
  it('builds "house# road, city, ST" and surfaces lat/lng', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '1700 Main Street, Indianapolis, IN, 46204, USA',
      lat: 39.77, lng: -86.15,
      houseNumber: '1700', road: 'Main Street',
      city: 'Indianapolis', township: null, municipality: 'Indianapolis',
      county: 'Marion', state: 'Indiana', postcode: '46204',
      importance: 0.6, addressType: 'house',
    });
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('1700 mane st indianapolis');
    expect(v.verified).toBe(true);
    expect(v.canonical).toBe('1700 Main Street, Indianapolis, IN');
    expect(v.lat).toBeCloseTo(39.77);
    expect(v.lng).toBeCloseTo(-86.15);
    expect(d.logs.some(l => l.event === 'GEOCODE_HIT_CREATE')).toBe(true);
  });

  it('treats a no-match as unverified and keeps the raw spelling', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('99999 nowhere blvd');
    expect(v.verified).toBe(false);
    expect(v.canonical).toBe('99999 nowhere blvd');
    expect(v.lat).toBe(null);
    expect(d.logs.some(l => l.event === 'GEOCODE_MISS_CREATE'
      && l.payload.reason === 'no_match')).toBe(true);
  });

  it('treats geocoder hits without road OR city as low_confidence (still unverified)', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: 'Marion County, IN, USA',
      lat: 39.7, lng: -86.1,
      houseNumber: null, road: null,
      city: null, township: null, municipality: null,
      county: 'Marion', state: 'Indiana', postcode: null,
      importance: 0.3, addressType: 'administrative',
    });
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('marion county area');
    expect(v.verified).toBe(false);
    expect(v.canonical).toBe('marion county area');
    expect(d.logs.some(l => l.event === 'GEOCODE_MISS_CREATE'
      && l.payload.reason === 'low_confidence')).toBe(true);
  });

  it('logs GEOCODE_ERROR_UPDATE when the geocoder throws', async () => {
    locationService.forwardGeocode.mockRejectedValueOnce(new Error('nominatim down'));
    const d = makeDispatcher();
    const v = await d._verifyAddressForCall('1 main st', { context: 'update' });
    expect(v.verified).toBe(false);
    expect(d.logs.some(l => l.event === 'GEOCODE_ERROR_UPDATE')).toBe(true);
  });
});

describe('Task #542: handleUpdateCall accepts an address slot and PATCHes canonical spelling', () => {
  it('confident hit → updates.location is canonical, updates.latitude/longitude included, ack mentions canonical', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY', location: 'OLD ADDR' },
    ]});
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '1700 Main Street, Indianapolis, IN, USA',
      lat: 39.77, lng: -86.15,
      houseNumber: '1700', road: 'Main Street',
      city: 'Indianapolis', state: 'Indiana',
      importance: 0.6,
    });
    const d = makeDispatcher();
    // Directly drive update with an address slot, simulating LLM extraction.
    await d.handleUpdateCall('INDIANA-1', 'update the address on the call to 1700 mane street', {
      address: '1700 mane street',
    });
    // First we land in the sole-call confirm prompt; updates already include
    // the canonical location and lat/lng.
    let session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_SOLE_CALL_UPDATE_CONFIRM);
    expect(session.slots.updates).toMatchObject({
      location: '1700 Main Street, Indianapolis, IN',
      latitude: 39.77,
      longitude: -86.15,
    });
    expect(session.slots.addressUnverified).toBe(false);

    // 10-4 on the sole-call confirm bridges into AWAITING_CALL_UPDATE_CONFIRM.
    await d.handleSoleCallUpdateConfirm('INDIANA-1', '10-4', session.slots);
    session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_UPDATE_CONFIRM);
    // Read-back mentions the canonical address, not the spoken raw.
    const lastSpoken = d.spoken[d.spoken.length - 1];
    expect(lastSpoken).toMatch(/address to 1700 Main Street, Indianapolis, IN/);
    expect(lastSpoken).not.toMatch(/I couldn't verify/);

    // Final confirm sends PATCH and the ack mentions the canonical address.
    await d.handleCallUpdateConfirm('INDIANA-1', '10-4', session.slots);
    expect(cadService.updateCall).toHaveBeenCalledTimes(1);
    const [calledId, calledUpdates] = cadService.updateCall.mock.calls[0];
    expect(calledId).toBe('uuid-only');
    expect(calledUpdates.location).toBe('1700 Main Street, Indianapolis, IN');
    expect(calledUpdates.latitude).toBeCloseTo(39.77);
    expect(calledUpdates.longitude).toBeCloseTo(-86.15);
    const ack = d.spoken[d.spoken.length - 1];
    expect(ack).toMatch(/10-4\. Address now 1700 Main Street, Indianapolis, IN\. Call updated\./);
    expect(ack).not.toMatch(/could not be verified/);
  });

  it('unverified address → ack warns "address could not be verified" and PATCH still uses raw spelling', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY', location: 'OLD ADDR' },
    ]});
    locationService.forwardGeocode.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.handleUpdateCall('INDIANA-1', 'update address to 99999 nowhere blvd', {
      address: '99999 nowhere blvd',
    });
    let session = cm.getUnitSessionState('INDIANA-1');
    expect(session.slots.addressUnverified).toBe(true);
    expect(session.slots.updates.location).toBe('99999 nowhere blvd');
    expect(session.slots.updates.latitude).toBeUndefined();

    await d.handleSoleCallUpdateConfirm('INDIANA-1', '10-4', session.slots);
    session = cm.getUnitSessionState('INDIANA-1');
    const confirmPrompt = d.spoken[d.spoken.length - 1];
    expect(confirmPrompt).toMatch(/I couldn't verify 99999 nowhere blvd/);

    await d.handleCallUpdateConfirm('INDIANA-1', '10-4', session.slots);
    const [, calledUpdates] = cadService.updateCall.mock.calls[0];
    expect(calledUpdates.location).toBe('99999 nowhere blvd');
    expect(calledUpdates.latitude).toBeUndefined();
    const ack = d.spoken[d.spoken.length - 1];
    expect(ack).toMatch(/Address now 99999 nowhere blvd\. Be advised, address could not be verified\./);
  });

  it('update without an address slot still works (priority-only, no PATCH location)', async () => {
    cadService.getActiveCalls.mockResolvedValue({ calls: [
      { call_id: 'uuid-only', call_number: 'CALL-ONLY' },
    ]});
    const d = makeDispatcher();
    await d.handleUpdateCall('INDIANA-1', 'upgrade to priority 1', {
      priority: '1',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.slots.updates).toMatchObject({ priority: '1' });
    expect(session.slots.updates.location).toBeUndefined();
    expect(session.slots.addressUnverified).toBe(false);
    expect(locationService.forwardGeocode).not.toHaveBeenCalled();
  });
});

describe('Task #542: createCall flow forwards verified lat/lng to CAD', () => {
  it('handleCallAddressInput verifies a spoken address and stashes lat/lng for executeCallCreation', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '500 Elm Street, Indianapolis, IN',
      lat: 39.5, lng: -86.0,
      houseNumber: '500', road: 'Elm Street',
      city: 'Indianapolis', state: 'Indiana',
      importance: 0.55,
    });
    const d = makeDispatcher();
    await d.handleCallAddressInput('INDIANA-1', '500 elm street', {
      nature: 'TRAFFIC STOP', additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_CONFIRM);
    expect(session.slots.address).toBe('500 Elm Street, Indianapolis, IN');
    expect(session.slots.addressLat).toBeCloseTo(39.5);
    expect(session.slots.addressLng).toBeCloseTo(-86.0);
    expect(session.slots.addressUnverified).toBe(false);

    await d.executeCallCreation('INDIANA-1', session.slots);
    expect(cadService.createCall).toHaveBeenCalledTimes(1);
    const call = cadService.createCall.mock.calls[0];
    // signature: (type, priority, location, municipality, notes, units, extras)
    expect(call[2]).toBe('500 Elm Street, Indianapolis, IN');
    expect(call[6]).toMatchObject({ lat: 39.5, lng: -86.0 });
  });

  it('address-first then nature-second: address is verified UPSTREAM and handleCallNatureInput trusts the saved canonical/lat/lng', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '500 Elm Street, Indianapolis, IN',
      lat: 39.5, lng: -86.0,
      houseNumber: '500', road: 'Elm Street',
      city: 'Indianapolis', state: 'Indiana',
      importance: 0.55,
    });
    const d = makeDispatcher();
    // Simulate the upstream stash from CASE 'CREATE_CALL_PROMPT' (address
    // only, no nature) by calling _verifyAddressForCall ourselves and
    // setting the same shape the upstream paths now persist.
    const v = await d._verifyAddressForCall('500 elm street', { context: 'create', participantId: 'INDIANA-1' });
    expect(v.verified).toBe(true);
    const savedSlots = {
      address: v.canonical,
      addressUnverified: !v.verified,
      addressLat: v.lat,
      addressLng: v.lng,
      additionalUnits: [],
      priority: 'medium',
      arrivalStatus: 'on_scene',
    };
    // Now the unit replies with the nature on the next turn.
    await d.handleCallNatureInput('INDIANA-1', 'traffic stop', savedSlots);
    // No second geocode call — saved metadata was trusted.
    expect(locationService.forwardGeocode).toHaveBeenCalledTimes(1);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.state).toBe(cm.DISPATCHER_STATE.AWAITING_CALL_CONFIRM);
    expect(session.slots.address).toBe('500 Elm Street, Indianapolis, IN');
    expect(session.slots.addressLat).toBeCloseTo(39.5);
    expect(session.slots.addressLng).toBeCloseTo(-86.0);
    expect(session.slots.addressUnverified).toBe(false);
    const confirmPrompt = d.spoken[d.spoken.length - 1];
    expect(confirmPrompt).toMatch(/at 500 Elm Street, Indianapolis, IN/);
    expect(confirmPrompt).not.toMatch(/I couldn't verify/);

    // And the CAD payload still carries lat/lng end-to-end.
    await d.executeCallCreation('INDIANA-1', session.slots);
    const call = cadService.createCall.mock.calls[0];
    expect(call[2]).toBe('500 Elm Street, Indianapolis, IN');
    expect(call[6]).toMatchObject({ lat: 39.5, lng: -86.0 });
  });

  it('defensive: handleCallNatureInput re-verifies a saved address when verification metadata is missing', async () => {
    // Older flow shape: saved address but no addressUnverified/addressLat
    // markers. The defensive geocode path must kick in.
    locationService.forwardGeocode.mockResolvedValueOnce({
      displayName: '500 Elm Street, Indianapolis, IN',
      lat: 39.5, lng: -86.0,
      houseNumber: '500', road: 'Elm Street',
      city: 'Indianapolis', state: 'Indiana',
      importance: 0.55,
    });
    const d = makeDispatcher();
    await d.handleCallNatureInput('INDIANA-1', 'traffic stop', {
      address: '500 elm street',
      additionalUnits: [],
      priority: 'medium',
      arrivalStatus: 'on_scene',
    });
    expect(locationService.forwardGeocode).toHaveBeenCalledTimes(1);
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.slots.address).toBe('500 Elm Street, Indianapolis, IN');
    expect(session.slots.addressUnverified).toBe(false);
    expect(session.slots.addressLat).toBeCloseTo(39.5);
    expect(session.slots.addressLng).toBeCloseTo(-86.0);
  });

  it('defensive: handleCallNatureInput on a no-match address warns the unit and stores unverified', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.handleCallNatureInput('INDIANA-1', 'traffic stop', {
      address: '99999 nowhere blvd',
      additionalUnits: [],
      priority: 'medium',
      arrivalStatus: 'on_scene',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.slots.addressUnverified).toBe(true);
    expect(session.slots.addressLat).toBe(null);
    const confirmPrompt = d.spoken[d.spoken.length - 1];
    expect(confirmPrompt).toMatch(/I couldn't verify 99999 nowhere blvd/);
  });

  it('handleCallAddressInput on a no-match flags addressUnverified and skips lat/lng on CAD', async () => {
    locationService.forwardGeocode.mockResolvedValueOnce(null);
    const d = makeDispatcher();
    await d.handleCallAddressInput('INDIANA-1', '99999 nowhere blvd', {
      nature: 'TRAFFIC STOP', additionalUnits: [], priority: 'medium', arrivalStatus: 'on_scene',
    });
    const session = cm.getUnitSessionState('INDIANA-1');
    expect(session.slots.addressUnverified).toBe(true);
    expect(session.slots.addressLat).toBe(null);
    const confirmPrompt = d.spoken[d.spoken.length - 1];
    expect(confirmPrompt).toMatch(/I couldn't verify 99999 nowhere blvd/);

    await d.executeCallCreation('INDIANA-1', session.slots);
    const call = cadService.createCall.mock.calls[0];
    expect(call[6]).toEqual({});
  });
});
