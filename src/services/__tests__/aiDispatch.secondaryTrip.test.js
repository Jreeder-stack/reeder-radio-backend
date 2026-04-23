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
  const RADIO_STATUS = {
    EN_ROUTE_SECONDARY: 'ENRTS',
    ARRIVED_SECONDARY: 'ARRVDS',
  };
  return {
    RADIO_STATUS,
    extractActualStatusFromRejection: () => null,
    isConfigured: () => true,
    updateUnitStatus: vi.fn(async () => ({ success: true })),
    addCallNote: vi.fn(async () => ({ success: true })),
    resolveUnitCurrentCall: vi.fn(async () => ({ call_id: 'CALL-123' })),
    rememberUnitUuid: vi.fn(),
    getCachedUnitUuid: vi.fn(() => null),
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

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  const cm = await import('../commandMatcher.js');
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

describe('SECONDARY_TRIP_START happy path', () => {
  it('updates status to ENRTS, adds STARTING MILEAGE note, stashes secondaryTrip and acks', async () => {
    const d = makeDispatcher();
    const transcript = 'en route to MDJ with one male, starting mileage 123456';

    await d.handleSecondaryTripStart('Indiana-1', transcript, {
      destination: 'MDJ',
      startingMileage: '123456',
      subjectCount: 1,
      subjectDescription: 'male',
    });

    expect(cadService.updateUnitStatus).toHaveBeenCalledWith('Indiana-1', 'ENRTS', 'CH-TEST');
    expect(cadService.addCallNote).toHaveBeenCalledWith(
      'CALL-123',
      'STARTING MILEAGE - 123456, en route to MDJ with 1 male'
    );
    expect(d.spoken[0]).toMatch(/Indiana-1, 10-4, en route to MDJ with one male, starting mileage one-two-three-four-five-six\./);

    const cm = await import('../commandMatcher.js');
    const session = cm.getUnitSessionState('Indiana-1');
    expect(session.slots.secondaryTrip).toBeTruthy();
    expect(session.slots.secondaryTrip.startingMileage).toBe(123456);
    expect(session.slots.secondaryTrip.destination).toBe('MDJ');
  });

  it('accepts free-text destination like "the Walmart"', async () => {
    const d = makeDispatcher();
    await d.handleSecondaryTripStart('Indiana-1', 'transporting to the Walmart, starting mileage 1000', {
      destination: 'the Walmart',
      startingMileage: '1000',
      subjectCount: 1,
      subjectDescription: 'subject',
    });

    expect(cadService.addCallNote).toHaveBeenCalledWith(
      'CALL-123',
      expect.stringContaining('en route to THE WALMART')
    );
  });
});

describe('SECONDARY_TRIP_ARRIVE', () => {
  it('writes ENDING MILEAGE note with stashed destination when bare endingMileage given', async () => {
    const d = makeDispatcher();

    await d.handleSecondaryTripStart('Indiana-1', 'en route to MDJ, starting mileage 123456', {
      destination: 'MDJ', startingMileage: '123456', subjectCount: 1, subjectDescription: 'male',
    });
    cadService.updateUnitStatus.mockClear();
    cadService.addCallNote.mockClear();

    await d.handleSecondaryTripArrive('Indiana-1', 'ending mileage 123478', {
      endingMileage: '123478',
    });

    expect(cadService.updateUnitStatus).toHaveBeenCalledWith('Indiana-1', 'ARRVDS', 'CH-TEST');
    expect(cadService.addCallNote).toHaveBeenCalledWith(
      'CALL-123',
      'ENDING MILEAGE - 123478, arrived at MDJ'
    );

    const cm = await import('../commandMatcher.js');
    expect(cm.getUnitSessionState('Indiana-1').slots.secondaryTrip).toBeFalsy();
  });

  it('triggers sanity-check when ending <= starting on record', async () => {
    const d = makeDispatcher();

    await d.handleSecondaryTripStart('Indiana-1', 'en route to MDJ, starting mileage 123478', {
      destination: 'MDJ', startingMileage: '123478', subjectCount: 1, subjectDescription: 'male',
    });
    cadService.updateUnitStatus.mockClear();
    cadService.addCallNote.mockClear();
    d.spoken = [];

    await d.handleSecondaryTripArrive('Indiana-1', 'ending mileage 123473', {
      endingMileage: '123473',
    });

    expect(cadService.updateUnitStatus).not.toHaveBeenCalled();
    expect(cadService.addCallNote).not.toHaveBeenCalled();
    expect(d.spoken[0]).toMatch(/lower than your starting mileage/i);

    const cm = await import('../commandMatcher.js');
    const sess = cm.getUnitSessionState('Indiana-1');
    expect(sess.state).toBe(cm.DISPATCHER_STATE.AWAITING_MILEAGE_CONFIRM);
  });

  it('arrive without prior start: still updates status and writes note', async () => {
    const d = makeDispatcher();
    await d.handleSecondaryTripArrive('Indiana-1', 'arriving at jail, ending mileage 5000', {
      destination: 'jail',
      endingMileage: '5000',
    });
    expect(cadService.updateUnitStatus).toHaveBeenCalledWith('Indiana-1', 'ARRVDS', 'CH-TEST');
    expect(cadService.addCallNote).toHaveBeenCalledWith(
      'CALL-123',
      'ENDING MILEAGE - 5000, arrived at JAIL'
    );
  });
});
