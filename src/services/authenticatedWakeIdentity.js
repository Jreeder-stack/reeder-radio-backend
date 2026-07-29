import { DISPATCHER_STATE, setUnitSessionState } from './commandMatcher.js';

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_UNIT_RX = /^\d{2,6}$/;
const NAMED_UNIT_RX = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d{1,4}$/;
const INTERNAL_ID_RX = /^(?:AI(?:-DISPATCHER)?|BOT|SIP|PIPELINE|SCANNER)(?:-|$)/i;

export function normalizeAuthenticatedUnitId(value) {
  const normalized = String(value || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-');

  if (!normalized || UUID_RX.test(normalized) || INTERNAL_ID_RX.test(normalized)) {
    return null;
  }

  if (NUMERIC_UNIT_RX.test(normalized) || NAMED_UNIT_RX.test(normalized)) {
    return normalized;
  }

  return null;
}

function isIdentifyPrompt(text) {
  return String(text || '').trim().toLowerCase() === 'unit calling central, identify.';
}

function isGoAheadReply(text) {
  return /^[a-z0-9-]+,\s*go ahead\.?$/i.test(String(text || '').trim());
}

/**
 * Restores metadata-first wake identity without changing the Central-first
 * radio procedure. The dispatcher already receives the authenticated sender
 * ID with each audio packet; this hook makes that identity authoritative when
 * STT hears only "Central" or mishears a spoken callsign.
 */
export function installAuthenticatedWakeIdentity(dispatcher, { log = null } = {}) {
  if (!dispatcher || dispatcher.__authenticatedWakeIdentityInstalled) {
    return dispatcher;
  }

  const originalLogSpeechEvent = typeof dispatcher.logSpeechEvent === 'function'
    ? dispatcher.logSpeechEvent
    : null;
  const originalSpeak = typeof dispatcher.speak === 'function'
    ? dispatcher.speak
    : null;
  const originalAddConversationExchange = typeof dispatcher.addConversationExchange === 'function'
    ? dispatcher.addConversationExchange
    : null;
  const originalEnterAwaitingIdentify = typeof dispatcher._enterAwaitingIdentify === 'function'
    ? dispatcher._enterAwaitingIdentify
    : null;

  if (!originalSpeak || !originalEnterAwaitingIdentify) {
    return dispatcher;
  }

  const pendingByParticipant = new Map();
  const emitLog = (action, details) => {
    if (typeof log === 'function') {
      log(action, details);
    } else if (typeof dispatcher.log === 'function') {
      dispatcher.log(action, details);
    }
  };

  dispatcher.logSpeechEvent = function authenticatedWakeLog(
    participantId,
    transcript,
    intent,
    response,
    ...rest
  ) {
    const authenticatedUnitId = normalizeAuthenticatedUnitId(participantId);
    const isBareCentral = intent === 'WAKE_BARE_CENTRAL' && isIdentifyPrompt(response);
    const isSpokenWake = intent === 'WAKE_WITH_UNIT' && isGoAheadReply(response);

    if (authenticatedUnitId && (isBareCentral || isSpokenWake)) {
      const reply = `${authenticatedUnitId}, go ahead.`;
      pendingByParticipant.set(participantId, {
        reply,
        overrideIdentifyState: isBareCentral,
      });
      emitLog('WAKE_AUTHENTICATED_IDENTITY_USED', {
        participant: participantId,
        authenticatedUnitId,
        transcript,
        originalIntent: intent,
        originalResponse: response,
      });
      if (originalLogSpeechEvent) {
        return originalLogSpeechEvent.call(
          this,
          participantId,
          transcript,
          isBareCentral ? 'WAKE_BARE_CENTRAL_AUTHENTICATED' : 'WAKE_WITH_UNIT_AUTHENTICATED',
          reply,
          ...rest,
        );
      }
      return undefined;
    }

    if (originalLogSpeechEvent) {
      return originalLogSpeechEvent.call(this, participantId, transcript, intent, response, ...rest);
    }
    return undefined;
  };

  dispatcher.speak = async function authenticatedWakeSpeak(text, participantId, ...rest) {
    const pending = pendingByParticipant.get(participantId);
    if (pending && (isIdentifyPrompt(text) || isGoAheadReply(text))) {
      return originalSpeak.call(this, pending.reply, participantId, ...rest);
    }
    return originalSpeak.call(this, text, participantId, ...rest);
  };

  if (originalAddConversationExchange) {
    dispatcher.addConversationExchange = function authenticatedWakeConversation(
      participantId,
      transcript,
      response,
      ...rest
    ) {
      const pending = pendingByParticipant.get(participantId);
      const finalResponse = pending && (isIdentifyPrompt(response) || isGoAheadReply(response))
        ? pending.reply
        : response;
      const result = originalAddConversationExchange.call(
        this,
        participantId,
        transcript,
        finalResponse,
        ...rest,
      );
      if (pending && !pending.overrideIdentifyState) {
        pendingByParticipant.delete(participantId);
      }
      return result;
    };
  }

  dispatcher._enterAwaitingIdentify = function authenticatedWakeState(participantId, ...rest) {
    const pending = pendingByParticipant.get(participantId);
    if (pending?.overrideIdentifyState) {
      pendingByParticipant.delete(participantId);
      setUnitSessionState(participantId, DISPATCHER_STATE.AWAITING_COMMAND);
      emitLog('WAKE_IDENTIFY_SKIPPED_AUTHENTICATED', {
        participant: participantId,
        authenticatedUnitId: normalizeAuthenticatedUnitId(participantId),
      });
      return undefined;
    }
    return originalEnterAwaitingIdentify.call(this, participantId, ...rest);
  };

  Object.defineProperty(dispatcher, '__authenticatedWakeIdentityInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  return dispatcher;
}
