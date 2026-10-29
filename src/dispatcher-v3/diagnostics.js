import { currentV3TurnEnvelope, isV3TurnEnvelope, isV3TurnIdentity } from './turnEnvelope.js';

// AI-DISP-V3-001 / 01-07. No audio, free-form transcripts, CAD payloads,
// model prompts or credential material in routine diagnostics or console logs.
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_RETENTION_MS = 15 * 60 * 1000;
const DEFAULT_RATE_PER_WINDOW = 12;
const DEFAULT_WINDOW_MS = 1000;
const MAX_DETAILS = 16;
const MAX_DEPTH = 3;
const MAX_STRING = 120;
const UNSAFE = /(secret|credential|password|token|api.?key|authorization|cookie|session|ssn|audio|pcm|wave|transcript|speechtext|utterance|prompt|messages|input|output|payload|body|content|note|description|address|caller|phone|location|latitude|longitude|headers|url|query|plan|response|result|text|raw|birth|name|email|evidence)/i;
const SAFE_DETAILS = new Set([
  'reason', 'code', 'cadCode', 'outcome', 'method', 'status', 'statusCode',
  'stage', 'kind', 'action', 'attempt', 'timeout', 'timedOut', 'timeoutMs',
  'captureAgeMs', 'queueAgeMs', 'processingMs', 'elapsedMs', 'latencyMs',
  'frames', 'framesSent', 'audioBytes', 'activeCallCount', 'truncated',
  'verified', 'success', 'granted', 'paged', 'deliveryId',
  'retryable', 'processed', 'rejected', 'totalTokens', 'promptTokens',
  'completionTokens', 'inputTokens', 'outputTokens', 'estimatedCostUsd',
  'source', 'phase', 'waiting', 'resident', 'unitCount', 'totalAgeMs',
  'speaker', 'target', 'pending', 'expired', 'stageMs', 'provider',
]);
const TERMINAL = new Set([
  'turn_completed', 'turn_scheduler_terminal', 'turn_capture_stopped',
  'outbound_completed', 'outbound_expired', 'outbound_failed',
  'outbound_interrupted', 'action_completed', 'action_failed',
]);
const ERROR_PHASES = new Set([
  'stt_failed', 'intent_failed', 'operational_context_failed',
  'speech_transmit_failed', 'emergency_alert_failed',
]);
const clampInt = (v, fallback, min, max) =>
  Number.isSafeInteger(v) ? Math.max(min, Math.min(max, v)) : fallback;
function sanitize(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value !== 'object' || depth >= MAX_DEPTH || seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value)) return '[REDACTED]';
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, MAX_DETAILS)) {
    // Unknown structures are omitted, not recursively dumped.
    // Numeric metadata is not audio or a bearer token. The allowlist still
    // excludes raw PCM, text, model payloads and credential values.
    if (!SAFE_DETAILS.has(key)) continue;
    if (UNSAFE.test(key) && !['audioBytes','promptTokens','completionTokens',
      'totalTokens','inputTokens','outputTokens'].includes(key)) continue;
    if (typeof child === 'object') continue;
    out[key] = sanitize(child, depth + 1, seen);
  }
  return out;
}
function kindFor(event, details) {
  const phase = String(event.phase || '');
  const code = String(details?.code || details?.cadCode || '');
  const reason = String(details?.reason || details?.outcome || '');
  if (phase.startsWith('outbound_') && /failed|expired|interrupted/.test(phase)) return 'delivery_failure';
  if (/transmit_failed|speech_skipped|alert_skipped/.test(phase)) return 'delivery_failure';
  if (/not_addressed|unit_to_unit/.test(reason)) return 'not_addressed';
  if (/empty_transcript|ptt_empty|unintelligible/.test(reason + ' ' + phase)) return 'unintelligible_audio';
  if (/AMBIGUOUS|ambiguous/.test(code + ' ' + reason)) return 'ambiguity';
  if (/INVALID_ACTION|unsupported/.test(code + ' ' + reason)) return 'unsupported_capability';
  if (/UNAUTHORIZED|TURN_STALE|identity_rejected|untrusted/.test(code + ' ' + reason)) return 'denied_action';
  if (/expired|timeout|canceled|cancelled|stale/.test(code.toLowerCase() + ' ' + reason.toLowerCase())) return 'expired_or_canceled';
  if (ERROR_PHASES.has(phase) || /CAD_UNAVAILABLE|OPERATION_TIMEOUT/.test(code)) return 'provider_failure';
  if (phase === 'action_failed') return 'action_failure';
  if (phase === 'turn_completed' || phase === 'turn_scheduler_terminal') return details?.outcome === 'processed' || details?.reason === 'processed' ? 'processed' : 'not_processed';
  if (phase === 'outbound_completed') return 'delivered_to_relay';
  return 'progress';
}
function authorized(access, center, runtime) {
  return !!access && access.dispatchCenterId === center && access.runtimeId === runtime
    && Array.isArray(access.scopes) && (access.scopes.includes('dispatcher.diagnostics.read') || access.scopes.includes('dispatcher.admin'));
}
export class V3DiagnosticsJournal {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, retentionMs = DEFAULT_RETENTION_MS,
    rateLimit = DEFAULT_RATE_PER_WINDOW, rateWindowMs = DEFAULT_WINDOW_MS,
    now = () => Date.now(), logger = console } = {}) {
    this.maxEntries = clampInt(maxEntries, DEFAULT_MAX_ENTRIES, 10, 1000);
    this.retentionMs = clampInt(retentionMs, DEFAULT_RETENTION_MS, 1000, 3600000);
    this.rateLimit = clampInt(rateLimit, DEFAULT_RATE_PER_WINDOW, 1, 100);
    this.rateWindowMs = clampInt(rateWindowMs, DEFAULT_WINDOW_MS, 100, 60000);
    this.now = now;
    this.logger = logger;
    this.entries = [];
    this.rate = new Map();
    this.suppressed = 0;
    this.counts = new Map();
    this.activeTurns = new Map();
    this.terminalTurns = new Map();
  }
  _purge(now) {
    const cutoff = now - this.retentionMs;
    while (this.entries.length && this.entries[0].at < cutoff) this.entries.shift();
    for (const [key, state] of this.rate) if (now - state.at >= this.rateWindowMs) this.rate.delete(key);
    for (const [key, value] of this.activeTurns) if (value.at < cutoff) this.activeTurns.delete(key);
    for (const [key, value] of this.terminalTurns) if (value.at < cutoff) this.terminalTurns.delete(key);
    while (this.rate.size > this.maxEntries) this.rate.delete(this.rate.keys().next().value);
    while (this.activeTurns.size > this.maxEntries) this.activeTurns.delete(this.activeTurns.keys().next().value);
    while (this.terminalTurns.size > this.maxEntries) this.terminalTurns.delete(this.terminalTurns.keys().next().value);
  }
  record(event = {}) {
    const now = this.now();
    this._purge(now);
    const candidate = event.turnEnvelope || currentV3TurnEnvelope();
    const turnEnvelope = isV3TurnEnvelope(candidate) ? candidate : null;
    const turnIdentity = turnEnvelope?.identity || (isV3TurnIdentity(event.turnIdentity) ? event.turnIdentity : null);
    const phase = String(event.phase || 'unknown').slice(0, 70);
    const runtimeId = event.runtimeId || turnIdentity?.runtimeId || null;
    const dispatchCenterId = event.dispatchCenterId || turnIdentity?.dispatchCenterId || null;
    const turnId = turnIdentity?.turnId || null;
    const safe = sanitize(event.details || {});
    const rawCode = event.details?.code ?? event.details?.error?.code;
    if (!safe.code && typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(rawCode)) safe.code = rawCode;
    const details = Object.freeze(safe);
    const classification = kindFor({ phase }, details);
    const terminal = TERMINAL.has(phase);
    const group = [runtimeId || '', dispatchCenterId || '', turnId || '-', phase].join('|');
    const rate = this.rate.get(group);
    if (!terminal && rate && now - rate.at < this.rateWindowMs && rate.count >= this.rateLimit) {
      this.suppressed++;
      return null;
    }
    if (!rate || now - rate.at >= this.rateWindowMs) this.rate.set(group, { at: now, count: 1 });
    else rate.count++;
    const entry = Object.freeze({
      at: now, timestamp: new Date(now).toISOString(), phase,
      classification, correlationId: event.correlationId || null,
      parentCorrelationId: event.parentCorrelationId || null,
      runtimeId, dispatchCenterId,
      channelId: event.channelId || turnIdentity?.channelId || null,
      action: event.action || null, unitId: event.unitId || null,
      success: typeof event.success === 'boolean' ? event.success : null,
      latencyMs: Number.isFinite(event.latencyMs) ? Math.max(0, event.latencyMs) : null,
      turnId, intakeSequence: turnIdentity?.intakeSequence ?? null,
      runtimeGeneration: turnIdentity?.runtimeGeneration || null,
      turnIdentity, turnEnvelope, details,
    });
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    this.counts.set(classification, (this.counts.get(classification) || 0) + 1);
    if (phase === 'turn_intake_accepted' && turnId) this.activeTurns.set(turnId, { at: now, runtimeId, dispatchCenterId });
    if (turnId && (phase === 'turn_completed' || phase === 'turn_scheduler_terminal' || phase === 'turn_capture_stopped')) {
      this.activeTurns.delete(turnId);
      if (!this.terminalTurns.has(turnId)) this.terminalTurns.set(turnId, { at: now, classification, phase, runtimeId, dispatchCenterId });
    }
    // The console receives only structural markers, never full event or details.
    if (this.logger?.info && (!rate || rate.count === 1)) {
      this.logger.info('[AI-V3-DIAG]', JSON.stringify({
        phase, classification, turnId, runtimeId, dispatchCenterId,
        success: entry.success, latencyMs: entry.latencyMs,
      }));
    }
    return entry;
  }
  getRecent({ limit = 50, runtimeId = null, correlationId = null, access = null } = {}) {
    this._purge(this.now());
    if (!authorized(access, access?.dispatchCenterId, runtimeId || access?.runtimeId)) return [];
    const filtered = this.entries.filter(e => e.dispatchCenterId === access.dispatchCenterId
      && e.runtimeId === access.runtimeId && (!correlationId || e.correlationId === correlationId));
    return filtered.slice(-clampInt(limit, 50, 1, this.maxEntries)).map(e => ({
      timestamp: e.timestamp, phase: e.phase, classification: e.classification,
      correlationId: e.correlationId, parentCorrelationId: e.parentCorrelationId,
      runtimeId: e.runtimeId, dispatchCenterId: e.dispatchCenterId, channelId: e.channelId,
      success: e.success, latencyMs: e.latencyMs, turnId: e.turnId,
      intakeSequence: e.intakeSequence, action: e.action, details: { ...e.details },
    }));
  }
  getTrace({ turnId, access } = {}) {
    if (!turnId || !authorized(access, access?.dispatchCenterId, access?.runtimeId)) return [];
    return this.getRecent({ access, runtimeId: access.runtimeId, limit: this.maxEntries })
      .filter(e => e.turnId === turnId);
  }
  getSummary({ runtimeId = null, dispatchCenterId = null } = {}) {
    this._purge(this.now());
    return Object.freeze({
      retained: this.entries.filter(e => (!runtimeId || e.runtimeId === runtimeId) &&
        (!dispatchCenterId || e.dispatchCenterId === dispatchCenterId)).length,
      suppressed: this.suppressed,
      activeTurns: [...this.activeTurns.values()].filter(e =>
        (!runtimeId || e.runtimeId === runtimeId) && (!dispatchCenterId || e.dispatchCenterId === dispatchCenterId)).length,
      terminalTurns: [...this.terminalTurns.values()].filter(e =>
        (!runtimeId || e.runtimeId === runtimeId) && (!dispatchCenterId || e.dispatchCenterId === dispatchCenterId)).length,
      classificationCounts: Object.fromEntries(this.counts),
    });
  }
  clear() {
    this.entries.length = 0;
    this.rate.clear(); this.activeTurns.clear(); this.terminalTurns.clear(); this.counts.clear();
    this.suppressed = 0;
  }
}
export function recordV3Diagnostic(journal, event) {
  if (!journal?.record) return null;
  return journal.record(event);
}
