const DEFAULT_PENDING_MS = 30000;
const TERMINAL_DELIVERY = new Set(['completed', 'failed', 'expired', 'interrupted']);
const EMERGENCY_RX = /\b(officer\s+down|shots?\s+fired|10[-\s/]?33|ten\s+thirty[-\s]?three|emergency\s+traffic|signal\s+100)\b/i;
const NUMBER_WORDS = Object.freeze({
  zero: '0', oh: '0',
  one: '1', won: '1',
  two: '2', too: '2',
  three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
});

// Receipts prove delivery only. Operation, call and clarification details
// are held exclusively in V3ConversationRecords, not duplicated here.
const MAX_PROMPT_RECEIPTS = 256;
const promptKey = (unit, sessionKey) => JSON.stringify([unit, sessionKey]);

export class V3ConversationGate {
  constructor({ wakeWords = null, pendingMs = DEFAULT_PENDING_MS, now = () => Date.now() } = {}) {
    this.pendingMs = pendingMs;
    this.now = now;
    this.pending = new Map();
    this.wakeWords = normalizeWakeWords(wakeWords);
  }

  // Explicit session-scoped lookup. A unit-only lookup is for diagnostics
  // and returns nothing if multiple authorized devices own questions.
  pendingFor(unitId, sessionKey = null) {
    const unit = clean(unitId);
    if (!unit) return undefined;
    if (sessionKey != null) return this.pending.get(promptKey(unit, sessionKey));
    const matches = [...this.pending.values()].filter((item) => item.unitId === unit);
    return matches.length === 1 ? matches[0] : undefined;
  }

  shouldProcess({ unitId, transcript, sessionKey = null, conversationId = null,
    taskId = null, runtimeGeneration = null, channelId = null, dispatcherIdentity = null } = {}) {
    const unit = clean(unitId);
    const text = clean(transcript);
    if (!unit || !text) return { allowed: false, reason: 'empty' };
    if (dispatcherIdentity && unit.toUpperCase() === clean(dispatcherIdentity)?.toUpperCase()) {
      return { allowed: false, reason: 'dispatcher_output' };
    }
    const matched = this.wakeWords.find((word) => new RegExp(`^\\s*${escapeRx(word)}(?:\\b|[,.:;-])`, 'i').test(text));
    // Urgent traffic keeps its addressing exemption. Normalize only a known
    // leading address, as for routine traffic, so complete urgent declarations
    // reach the same meaning-preserving planner without a keyword bypass.
    if (EMERGENCY_RX.test(text)) return { allowed: true, reason: 'emergency', transcript: matched ? stripLeadingWake(text, matched) || text : text };

    // An explicit wake word always starts a fresh dispatcher turn. This check
    // must run BEFORE pending-follow-up handling; otherwise a stale CLARIFY
    // window can hijack "Central, ..." and keep asking the same old question.
    if (matched) {
      // A new explicitly addressed command supersedes this session's prompt.
      // An unrelated authenticated connection cannot clear the owner's task.
      this.clear(unit, sessionKey);
      const remainder = stripLeadingWake(text, matched);
      if (looksLikeSpeakerHail(remainder, unit)) {
        return {
          allowed: true,
          reason: 'wake_word',
          transcript: unit,
          hailSource: 'signaling_identity',
          heardTranscript: remainder || null,
          freshRequest: true,
        };
      }
      return { allowed: true, reason: 'wake_word', transcript: remainder || text, freshRequest: true };
    }

    const pending = this.pendingFor(unit, sessionKey);
    if (!pending) return { allowed: false, reason: 'not_addressed' };

    // A callsign is not custody. Only the exact authenticated conversation,
    // active task, generation and channel of the transmitted question may reply.
    if (pending.sessionKey !== sessionKey) return { allowed: false, reason: 'not_addressed' };
    if (!matchesScope(pending, { sessionKey, conversationId, taskId, runtimeGeneration, channelId })) {
      this.clear(unit, sessionKey);
      return { allowed: false, reason: 'pending_task_changed' };
    }
    if (pending.promptState !== 'delivered') {
      // The speech may still be queued, blocked, synthesizing or interrupted.
      return { allowed: false, reason: 'prompt_not_delivered' };
    }
    if (pending.expiresAt < this.now()) {
      this.clear(unit, sessionKey);
      return { allowed: false, reason: 'prompt_expired' };
    }
    if (looksLikeUnitToUnitTraffic(text, unit, pending)) {
      // Overheard traffic is not an answer and must not cancel a valid prompt.
      return { allowed: false, reason: 'unit_to_unit', transcript: text };
    }
    return { allowed: true, reason: 'follow_up', transcript: text, pending };
  }

  // Creates a NON-ACTIONABLE prompt awaiting an outbound transmission receipt.
  // The reply clock is not started here, and there is no legacy timer fallback.
  expectFollowUp(unitId, context = {}) {
    const unit = clean(unitId);
    const required = ['sessionKey', 'conversationId', 'taskId', 'promptTurnId', 'runtimeGeneration', 'channelId'];
    if (!unit || required.some((key) => !clean(context[key]))) return null;
    const key = promptKey(unit, context.sessionKey);
    if (!this.pending.has(key) && this.pending.size >= MAX_PROMPT_RECEIPTS) return null;
    // The only retained fields are trusted routing/receipt identity and a
    // non-actionable kind label for radio-to-radio traffic classification.
    const pending = {
      unitId: unit, sessionKey: context.sessionKey,
      conversationId: context.conversationId, taskId: context.taskId,
      promptTurnId: context.promptTurnId, runtimeGeneration: context.runtimeGeneration,
      channelId: context.channelId, kind: clean(context.kind) || 'clarification',
      promptState: 'awaiting_delivery', createdAt: this.now(),
      deliveredAt: null, expiresAt: null,
    };
    this.pending.set(key, pending);
    return pending;
  }

  // Only the actual outbound terminal result can open the answer window.
  // Matching the original turn (plus session/task/channel/generation) prevents
  // a superseded or another unit's completion from opening a newer question.
  settlePromptDelivery({ unitId, promptTurnId, sessionKey, conversationId, taskId,
    runtimeGeneration, channelId, status } = {}) {
    if (!TERMINAL_DELIVERY.has(status)) return false;
    const unit = clean(unitId), pending = this.pendingFor(unit, sessionKey);
    if (!pending || pending.promptState !== 'awaiting_delivery' || pending.promptTurnId !== promptTurnId
      || !matchesScope(pending, { sessionKey, conversationId, taskId, runtimeGeneration, channelId })) return false;
    if (status === 'completed') {
      pending.promptState = 'delivered';
      pending.deliveredAt = this.now();
      pending.expiresAt = pending.deliveredAt + this.pendingMs;
    } else {
      this.clear(unit, sessionKey);
    }
    return true;
  }

  isCurrentPending(unitId, pending) {
    const unit = clean(unitId);
    return !!unit && !!pending && this.pendingFor(unit, pending.sessionKey) === pending
      && pending.promptState === 'delivered'
      && Number.isFinite(pending.expiresAt) && pending.expiresAt >= this.now();
  }

  clear(unitId, sessionKey = null) {
    const unit = clean(unitId);
    if (!unit) return;
    if (sessionKey != null) {
      this.pending.delete(promptKey(unit, sessionKey));
      return;
    }
    for (const [key, pending] of this.pending) {
      if (pending.unitId === unit) this.pending.delete(key);
    }
  }

  clearAll() {
    this.pending.clear();
  }
}

function matchesScope(pending, { sessionKey, conversationId, taskId, runtimeGeneration, channelId }) {
  return !!pending && pending.sessionKey === sessionKey && pending.conversationId === conversationId
    && pending.taskId === taskId && pending.runtimeGeneration === runtimeGeneration
    && pending.channelId === channelId;
}

function normalizeWakeWords(value) {
  const configured = value ?? process.env.AI_DISPATCHER_WAKE_WORDS ?? 'central,dispatch,dispatcher';
  const words = Array.isArray(configured) ? value : String(configured).split(',');
  return words.map((word) => clean(word)?.toLowerCase()).filter(Boolean);
}

function stripLeadingWake(text, word) {
  return text.replace(new RegExp(`^\\s*${escapeRx(word)}\\s*[,.:;-]?\\s*`, 'i'), '').trim();
}

// Normalize the address without changing pending dialogue or granting access.
// Emergency reply matching uses this before the ordinary conversation gate.
export function stripV3LeadingAddress(transcript, wakeWords) {
  const text = clean(transcript) || '';
  const matched = normalizeWakeWords(wakeWords).find((word) => new RegExp(`^\\s*${escapeRx(word)}(?:\\b|[,.:;-])`, 'i').test(text));
  return matched ? stripLeadingWake(text, matched) || text : text;
}

function looksLikeSpeakerHail(remainder, unitId) {
  const heard = normalizeCallsign(remainder);
  const unit = normalizeCallsign(unitId);
  if (!unit) return false;
  if (!heard) return true;
  if (heard === unit) return true;

  const alphaPrefix = unit.replace(/\s*\d+\s*$/, '').trim();
  if (alphaPrefix && heard === alphaPrefix) return true;

  return false;
}

function looksLikeUnitToUnitTraffic(text, speakerUnitId, pending) {
  const normalizedText = normalizeCallsign(text);
  const speaker = normalizeCallsign(speakerUnitId);
  if (!normalizedText || !speaker) return false;

  const speakerMatch = speaker.match(/^(.*?)(?:\s+)(\d+)$/);
  if (speakerMatch) {
    const [, family, ownNumber] = speakerMatch;
    const familyRx = new RegExp(`^${escapeRx(family)}\\s+(\\d+)(?:\\b|$)`, 'i');
    const addressed = normalizedText.match(familyRx);
    if (addressed && addressed[1] !== ownNumber) {
      if (pending?.kind === 'radio_hail') return true;
      return normalizedText.length > addressed[0].length;
    }
  }

  // Direct callsigns from another family explicitly hailed at the beginning
  // also address another radio unit; an isolated callsign can still answer
  // "Which unit?" and must not be discarded as cross-unit speech.
  const directed = text.match(/^\s*([a-z][a-z0-9_-]*\s*\d+)\s*[,;:]\s*(\S.+)$/i);
  if (directed && normalizeCallsign(directed[1]) !== speaker) return true;

  const genericAddress = normalizedText.match(/^(?:unit|car|officer|patrol|security|radio)\s+\d+(?:\b|$)/i);
  if (!genericAddress) return false;
  if (pending?.kind === 'radio_hail') return true;
  return normalizedText.length > genericAddress[0].length;
}

function normalizeCallsign(value) {
  const text = clean(value);
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[,.:'’;/_-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] || token)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRx(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
