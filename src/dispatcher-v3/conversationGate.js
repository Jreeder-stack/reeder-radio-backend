const DEFAULT_PENDING_MS = 30000;
const EMERGENCY_RX = /\b(officer\s+down|shots?\s+fired|10[-\s/]?33|ten\s+thirty[-\s]?three|emergency\s+traffic|signal\s+100)\b/i;
const NUMBER_WORDS = Object.freeze({
  zero: '0', oh: '0',
  one: '1', won: '1',
  two: '2', too: '2',
  three: '3', four: '4', for: '4', five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
  ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20',
});

export class V3ConversationGate {
  constructor({ wakeWords = null, pendingMs = DEFAULT_PENDING_MS, now = () => Date.now() } = {}) {
    this.pendingMs = pendingMs;
    this.now = now;
    this.pending = new Map();
    this.wakeWords = normalizeWakeWords(wakeWords);
  }

  shouldProcess({ unitId, transcript } = {}) {
    const unit = clean(unitId);
    const text = clean(transcript);
    if (!unit || !text) return { allowed: false, reason: 'empty' };
    if (EMERGENCY_RX.test(text)) return { allowed: true, reason: 'emergency', transcript: text };

    // An explicit wake word always starts a fresh dispatcher turn. This check
    // must run BEFORE pending-follow-up handling; otherwise a stale CLARIFY
    // window can hijack "Central, ..." and keep asking the same old question.
    const matched = this.wakeWords.find((word) => new RegExp(`^\\s*${escapeRx(word)}(?:\\b|[,.:;-])`, 'i').test(text));
    if (matched) {
      this.pending.delete(unit);
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

    const pending = this.pending.get(unit);
    if (pending && pending.expiresAt >= this.now()) {
      if (looksLikeUnitToUnitTraffic(text, unit, pending)) {
        this.pending.delete(unit);
        return { allowed: false, reason: 'unit_to_unit', transcript: text };
      }
      return { allowed: true, reason: 'follow_up', transcript: text, pending };
    }
    if (pending) this.pending.delete(unit);

    return { allowed: false, reason: 'not_addressed' };
  }

  expectFollowUp(unitId, context = {}) {
    const unit = clean(unitId);
    if (!unit) return;
    this.pending.set(unit, { ...context, expiresAt: this.now() + this.pendingMs });
  }

  clear(unitId) {
    this.pending.delete(clean(unitId));
  }

  clearAll() {
    this.pending.clear();
  }
}

function normalizeWakeWords(value) {
  const configured = value ?? process.env.AI_DISPATCHER_WAKE_WORDS ?? 'central,dispatch,dispatcher';
  const words = Array.isArray(configured) ? value : String(configured).split(',');
  return words.map((word) => clean(word)?.toLowerCase()).filter(Boolean);
}

function stripLeadingWake(text, word) {
  return text.replace(new RegExp(`^\\s*${escapeRx(word)}\\s*[,.:;-]?\\s*`, 'i'), '').trim();
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
