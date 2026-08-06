const DEFAULT_MAX_ENTRIES = 500;

const SENSITIVE_KEYS = new Set([
  'apiKey',
  'api_key',
  'authorization',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'ssn',
]);

function cloneForDiagnostics(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => cloneForDiagnostics(item, seen));
  }

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SENSITIVE_KEYS.has(key)
      ? '[REDACTED]'
      : cloneForDiagnostics(child, seen);
  }
  return result;
}

export class V3DiagnosticsJournal {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, now = () => Date.now(), logger = console } = {}) {
    this.maxEntries = Math.max(10, Number(maxEntries) || DEFAULT_MAX_ENTRIES);
    this.now = now;
    this.logger = logger;
    this.entries = [];
  }

  record(event = {}) {
    const entry = Object.freeze({
      timestamp: new Date(this.now()).toISOString(),
      phase: String(event.phase || 'unknown'),
      correlationId: event.correlationId || null,
      parentCorrelationId: event.parentCorrelationId || null,
      runtimeId: event.runtimeId || null,
      dispatchCenterId: event.dispatchCenterId || null,
      channelId: event.channelId || null,
      action: event.action || null,
      unitId: event.unitId || null,
      success: typeof event.success === 'boolean' ? event.success : null,
      latencyMs: Number.isFinite(event.latencyMs) ? event.latencyMs : null,
      details: Object.freeze(cloneForDiagnostics(event.details || {})),
    });

    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }

    if (this.logger?.info) {
      this.logger.info('[AI-V3-DIAG]', JSON.stringify(entry));
    }
    return entry;
  }

  getRecent({ limit = 50, runtimeId = null, correlationId = null } = {}) {
    let filtered = this.entries;
    if (runtimeId) filtered = filtered.filter((entry) => entry.runtimeId === runtimeId);
    if (correlationId) filtered = filtered.filter((entry) => entry.correlationId === correlationId);
    const safeLimit = Math.max(1, Math.min(Number(limit) || 50, this.maxEntries));
    return filtered.slice(-safeLimit).map((entry) => ({ ...entry, details: { ...entry.details } }));
  }

  clear() {
    this.entries.length = 0;
  }
}

export function recordV3Diagnostic(journal, event) {
  if (!journal?.record) return null;
  return journal.record(event);
}
