const DEFAULT_PENDING_MS = 30000;
const EMERGENCY_RX = /\b(officer\s+down|shots?\s+fired|10[-\s/]?33|ten\s+thirty[-\s]?three|emergency\s+traffic|signal\s+100)\b/i;

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

    const pending = this.pending.get(unit);
    if (pending && pending.expiresAt >= this.now()) {
      return { allowed: true, reason: 'follow_up', transcript: text, pending };
    }
    if (pending) this.pending.delete(unit);

    const matched = this.wakeWords.find((word) => new RegExp(`(^|\\b)${escapeRx(word)}(?:\\b|[,.:;-])`, 'i').test(text));
    if (!matched) return { allowed: false, reason: 'not_addressed' };
    return { allowed: true, reason: 'wake_word', transcript: stripLeadingWake(text, matched) };
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
  const words = Array.isArray(configured) ? configured : String(configured).split(',');
  return words.map((word) => clean(word)?.toLowerCase()).filter(Boolean);
}

function stripLeadingWake(text, word) {
  return text.replace(new RegExp(`^\\s*${escapeRx(word)}\\s*[,.:;-]?\\s*`, 'i'), '').trim() || text;
}

function escapeRx(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
