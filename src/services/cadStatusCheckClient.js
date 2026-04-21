import WebSocket from 'ws';
import * as cadService from './cadService.js';

const STATUS_CHECK_EVENTS = new Set([
  'status_check_due',
  'status_check_escalated',
  'status_check_acknowledged',
  'status_check_snoozed',
  'status_check_cancelled',
]);

const POLL_INTERVAL_MS = 15000;
const POLL_LOOKAHEAD_SEC = 30;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_TIMEOUT_MS = 30000;

function log(action, details = {}) {
  console.log(`[CAD-StatusCheck] ${new Date().toISOString()} | ${action}`, JSON.stringify(details));
}

function buildWsUrl() {
  const cadUrl = process.env.CAD_URL;
  const apiKey = process.env.CAD_API_KEY;
  if (!cadUrl || !apiKey) return null;
  let base = cadUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/+$/, '');
  return `${base}/ws?api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Normalize a CAD WS or polled payload into a flat canonical envelope.
 * CAD WS messages use `{ type, agencyId, data: { unitId, callId, ... } }`,
 * but we also handle flat shapes (poll synthesis, future API changes).
 */
function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const data = (raw.data && typeof raw.data === 'object') ? raw.data : {};
  // Merge data into top-level fields without losing top-level identifiers.
  const merged = { ...data, ...raw };
  // Re-flatten common nested keys so callers can rely on top-level access.
  merged.unit_id = raw.unit_id || raw.unitId || data.unit_id || data.unitId || null;
  merged.unit_number = raw.unit_number || raw.unitNumber || data.unit_number || data.unitNumber || null;
  merged.call_id = raw.call_id || raw.callId || data.call_id || data.callId || null;
  merged.assignment_id = raw.assignment_id || raw.assignmentId || data.assignment_id || data.assignmentId || null;
  merged.check_id = raw.check_id || raw.checkId || data.check_id || data.checkId || raw.id || data.id || null;
  merged.due_at = raw.due_at || raw.dueAt || data.due_at || data.dueAt || null;
  merged.call_number = raw.call_number || raw.callNumber || data.call_number || data.callNumber || null;
  merged.agency_id = raw.agency_id || raw.agencyId || data.agency_id || data.agencyId || null;
  merged.event = raw.event || raw.type || data.event || data.type || null;
  merged.sequence = raw.sequence ?? raw.seq ?? data.sequence ?? data.seq ?? null;
  merged.cycle = raw.cycle ?? data.cycle ?? null;
  return merged;
}

function eventKey(evt) {
  const type = evt.event || '';
  const unitId = evt.unit_id || '';
  const callId = evt.call_id || '';
  const assignmentId = evt.assignment_id || '';
  // Cycle/sequence/check_id let us distinguish successive due events for the
  // same assignment so dedupe doesn't permanently suppress future cycles.
  const cycle = evt.cycle ?? evt.sequence ?? evt.check_id ?? evt.due_at ?? '';
  return `${type}|${assignmentId}|${unitId}|${callId}|${cycle}`;
}

class CadStatusCheckClient {
  constructor() {
    this.ws = null;
    this.handler = null;
    this.running = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._pingTimer = null;
    this._pollTimer = null;
    this._seenKeys = new Map();
    this._selfRespondedCallIds = new Map();
  }

  start(handler) {
    if (!cadService.isConfigured()) {
      log('START_SKIPPED', { reason: 'CAD not configured' });
      return;
    }
    if (this.running) {
      this.handler = handler;
      return;
    }
    this.handler = handler;
    this.running = true;
    log('START', { url: buildWsUrl()?.replace(/api_key=[^&]+/, 'api_key=***') });
    this._connect();
    this._startPolling();
  }

  stop() {
    this.running = false;
    this.handler = null;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null; }
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this.ws) {
      try { this.ws.removeAllListeners(); this.ws.close(); } catch (e) {}
      this.ws = null;
    }
    this._seenKeys.clear();
    this._selfRespondedCallIds.clear();
    log('STOPPED');
  }

  /**
   * Mark an inbound acknowledgment as self-generated so the only the matching
   * round-trip event from CAD is ignored. Keyed on (callId + unit identity)
   * so other units' acks on the same call are NOT suppressed.
   *
   * `unitForms` is an array of identifier forms we know for this unit (radio
   * callsign and/or UUID). Inbound match succeeds if the event carries any
   * of these forms in either unit_number or unit_id.
   */
  markSelfResponded(unitForms, callId) {
    if (!callId) return;
    const forms = (Array.isArray(unitForms) ? unitForms : [unitForms]).filter(Boolean);
    if (!forms.length) return;
    const ts = Date.now();
    for (const form of forms) {
      const key = `${String(callId)}|${String(form).toUpperCase()}`;
      this._selfRespondedCallIds.set(key, ts);
      setTimeout(() => this._selfRespondedCallIds.delete(key), 30000).unref?.();
    }
  }

  _consumeSelfResponded(unitForms, callId) {
    if (!callId) return false;
    const forms = (Array.isArray(unitForms) ? unitForms : [unitForms]).filter(Boolean);
    for (const form of forms) {
      const key = `${String(callId)}|${String(form).toUpperCase()}`;
      if (this._selfRespondedCallIds.has(key)) {
        this._selfRespondedCallIds.delete(key);
        return true;
      }
    }
    return false;
  }

  _connect() {
    const url = buildWsUrl();
    if (!url) {
      log('CONNECT_SKIPPED', { reason: 'no CAD URL/key' });
      return;
    }
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      log('CONNECT_ERROR', { error: err.message });
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      log('CONNECTED');
      this._reconnectAttempts = 0;
      this._armPingTimeout();
    });

    ws.on('ping', () => {
      try { ws.pong(); } catch (e) {}
      this._armPingTimeout();
    });

    ws.on('pong', () => this._armPingTimeout());

    ws.on('message', (raw) => {
      this._armPingTimeout();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        log('PARSE_ERROR', { error: err.message });
        return;
      }
      this._handleEvent(msg);
    });

    ws.on('close', (code, reason) => {
      log('CLOSED', { code, reason: reason?.toString() });
      if (this._pingTimer) { clearTimeout(this._pingTimer); this._pingTimer = null; }
      this.ws = null;
      if (this.running) this._scheduleReconnect();
    });

    ws.on('error', (err) => {
      log('WS_ERROR', { error: err.message });
    });
  }

  _armPingTimeout() {
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._pingTimer = setTimeout(() => {
      log('PING_TIMEOUT', { ms: PING_TIMEOUT_MS });
      try { this.ws?.terminate(); } catch (e) {}
    }, PING_TIMEOUT_MS);
    this._pingTimer.unref?.();
  }

  _scheduleReconnect() {
    if (!this.running) return;
    if (this._reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_MS);
    this._reconnectAttempts++;
    log('RECONNECT_SCHEDULED', { attempt: this._reconnectAttempts, delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.running) this._connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  _startPolling() {
    this._pollOnce();
    this._pollTimer = setInterval(() => this._pollOnce(), POLL_INTERVAL_MS);
    this._pollTimer.unref?.();
  }

  async _pollOnce() {
    if (!this.running) return;
    try {
      const result = await cadService.getPendingChecks(POLL_LOOKAHEAD_SEC);
      if (!result || result.success === false) return;
      const checks = result.checks || result.pending_checks || [];
      const now = Date.now();
      for (const check of checks) {
        const state = String(check.state || check.status || '').toLowerCase();
        const dueAtRaw = check.due_at || check.dueAt;
        const dueAtMs = dueAtRaw ? new Date(dueAtRaw).getTime() : null;

        // Map CAD state -> event type. Skip anything not currently
        // due/escalated (e.g. snoozed, idle) — we only synthesize
        // status_check_due if the timer has actually elapsed.
        let eventType = null;
        if (state === 'escalated') {
          eventType = 'status_check_escalated';
        } else if (state === 'pending' || state === 'due') {
          if (dueAtMs == null || dueAtMs <= now) {
            eventType = 'status_check_due';
          } else {
            // Within lookahead window but not yet due — do not prompt early.
            continue;
          }
        } else {
          // unknown state (snoozed, ack'd, cancelled, idle, etc.) — skip
          continue;
        }

        const synthesized = {
          event: eventType,
          unit_id: check.unit_id || check.unitId,
          unit_number: check.unit_number || check.unitNumber,
          call_id: check.call_id || check.callId,
          call_number: check.call_number || check.callNumber,
          id: check.id || check.check_id || check.checkId,
          due_at: dueAtRaw,
          source: 'poll',
          ...check,
        };
        // Re-assert event type after spread in case `check` had a different one.
        synthesized.event = eventType;
        this._handleEvent(synthesized);
      }
    } catch (err) {
      log('POLL_ERROR', { error: err.message });
    }
  }

  _handleEvent(rawEvt) {
    const evt = normalizeEvent(rawEvt);
    if (!evt) return;
    const type = evt.event;
    if (!STATUS_CHECK_EVENTS.has(type)) return;

    // Optional tenant guard: drop events for other agencies if AGENCY_ID set.
    const agencyFilter = process.env.CAD_AGENCY_ID;
    if (agencyFilter && evt.agency_id && String(evt.agency_id) !== String(agencyFilter)) {
      log('AGENCY_FILTERED', { eventAgency: evt.agency_id, ourAgency: agencyFilter });
      return;
    }

    // Sliding time-based dedupe — independent of map size.
    const now = Date.now();
    const DEDUP_TTL_MS = 5 * 60 * 1000;
    const key = eventKey(evt);
    if (key) {
      const prev = this._seenKeys.get(key);
      if (prev && (now - prev) < DEDUP_TTL_MS) return;
      this._seenKeys.set(key, now);
      // Periodic eviction of stale entries
      if (now - (this._lastEviction || 0) > 60000) {
        this._lastEviction = now;
        const cutoff = now - DEDUP_TTL_MS;
        for (const [k, ts] of this._seenKeys) {
          if (ts < cutoff) this._seenKeys.delete(k);
        }
      }
    }

    const unitId = evt.unit_id;
    const unitNumber = evt.unit_number;
    const callId = evt.call_id;

    // Self-event suppression: ignore acks the radio backend itself caused.
    if (type === 'status_check_acknowledged' && this._consumeSelfResponded([unitNumber, unitId], callId)) {
      log('ACK_SELF_SUPPRESSED', { unitId, unitNumber, callId });
      return;
    }

    log('EVENT', { type, unitId, unitNumber, callId, source: evt.source || 'ws' });

    if (typeof this.handler === 'function') {
      try {
        this.handler({ type, unitId, unitNumber, callId, raw: evt });
      } catch (err) {
        log('HANDLER_ERROR', { error: err.message });
      }
    }
  }
}

export const cadStatusCheckClient = new CadStatusCheckClient();
export default cadStatusCheckClient;
