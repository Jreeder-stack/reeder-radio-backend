import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installAuthenticatedWakeIdentity,
  normalizeAuthenticatedUnitId,
} from '../authenticatedWakeIdentity.js';
import {
  DISPATCHER_STATE,
  getUnitSessionState,
  resetDispatcherState,
} from '../commandMatcher.js';

function makeDispatcher() {
  return {
    spoken: [],
    speechEvents: [],
    conversations: [],
    identifyCalls: [],
    logs: [],
    log(action, details) {
      this.logs.push({ action, details });
    },
    logSpeechEvent(participantId, transcript, intent, response) {
      this.speechEvents.push({ participantId, transcript, intent, response });
    },
    async speak(text, participantId) {
      this.spoken.push({ text, participantId });
    },
    addConversationExchange(participantId, transcript, response) {
      this.conversations.push({ participantId, transcript, response });
    },
    _enterAwaitingIdentify(participantId) {
      this.identifyCalls.push(participantId);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetDispatcherState();
});

afterEach(() => {
  resetDispatcherState();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('authenticated AI dispatcher wake identity', () => {
  it('accepts assigned radio callsigns and rejects internal IDs', () => {
    expect(normalizeAuthenticatedUnitId('Indiana-1')).toBe('INDIANA-1');
    expect(normalizeAuthenticatedUnitId('5012')).toBe('5012');
    expect(normalizeAuthenticatedUnitId('d6b507a9-ab40-4bf6-9fec-068c164193c0')).toBeNull();
    expect(normalizeAuthenticatedUnitId('AI-Dispatcher')).toBeNull();
  });

  it('answers bare Central with the authenticated radio identity', async () => {
    const dispatcher = makeDispatcher();
    installAuthenticatedWakeIdentity(dispatcher);

    dispatcher.logSpeechEvent(
      'INDIANA-1',
      'Central',
      'WAKE_BARE_CENTRAL',
      'Unit calling Central, identify.',
    );
    await dispatcher.speak('Unit calling Central, identify.', 'INDIANA-1');
    dispatcher.addConversationExchange(
      'INDIANA-1',
      'Central',
      'Unit calling Central, identify.',
    );
    dispatcher._enterAwaitingIdentify('INDIANA-1');

    expect(dispatcher.spoken).toEqual([
      { text: 'INDIANA-1, go ahead.', participantId: 'INDIANA-1' },
    ]);
    expect(dispatcher.conversations[0].response).toBe('INDIANA-1, go ahead.');
    expect(dispatcher.identifyCalls).toEqual([]);
    expect(getUnitSessionState('INDIANA-1').state).toBe(DISPATCHER_STATE.AWAITING_COMMAND);
  });

  it('keeps the identify prompt when sender metadata is not a valid unit ID', async () => {
    const dispatcher = makeDispatcher();
    const uuid = 'd6b507a9-ab40-4bf6-9fec-068c164193c0';
    installAuthenticatedWakeIdentity(dispatcher);

    dispatcher.logSpeechEvent(uuid, 'Central', 'WAKE_BARE_CENTRAL', 'Unit calling Central, identify.');
    await dispatcher.speak('Unit calling Central, identify.', uuid);
    dispatcher.addConversationExchange(uuid, 'Central', 'Unit calling Central, identify.');
    dispatcher._enterAwaitingIdentify(uuid);

    expect(dispatcher.spoken[0].text).toBe('Unit calling Central, identify.');
    expect(dispatcher.identifyCalls).toEqual([uuid]);
  });

  it('does not let a conflicting spoken callsign override authenticated metadata', async () => {
    const dispatcher = makeDispatcher();
    installAuthenticatedWakeIdentity(dispatcher);

    dispatcher.logSpeechEvent(
      'INDIANA-1',
      'Central from Indiana two',
      'WAKE_WITH_UNIT',
      'INDIANA-2, go ahead.',
    );
    await dispatcher.speak('INDIANA-2, go ahead.', 'INDIANA-1');
    dispatcher.addConversationExchange(
      'INDIANA-1',
      'Central from Indiana two',
      'INDIANA-2, go ahead.',
    );

    expect(dispatcher.spoken[0].text).toBe('INDIANA-1, go ahead.');
    expect(dispatcher.conversations[0].response).toBe('INDIANA-1, go ahead.');
  });
});
