import WebSocket from 'ws';
import * as cadService from './cadService.js';
import { runWithRuntime } from './runtimeContext.js';

const STATUS_CHECK_EVENTS = new Set([
  'status_check_due',
  'status_check_escalated',
  'status_check_acknowledged',
  'status_check_snoozed',
  'status_check_cancelled',
  'status_check_overdue',
  'status_check_fired',
  'status_check_pending',
  'status_check_notification',
  'status_check_alert',
  'status_check_unacknowledged',
]);

const FIRE_EVENT_TYPES = new Set([
  'status_check_due',
  'status_check_pending',
  'status_check_fired',
  'status_check_notification',
  'status_check_alert',
]);
const ESCALATED_EVENT_TYPES = new Set([
  'status_check_escalated',
  'status_check_overdue',
  'status_check_unacknowledged',
  'status_check_expired',
]);
const TERMINAL_EVENT_TYPES = new Set([
  'status_check_acknowledged',
  'status_check_ack',
  'status_check_acked',
  'status_check_snoozed',
  'status_check_cancelled',
  'status_check_canceled',
  'status_check_resolved',
  'status_check_closed',
  'status_check_completed',
]);

const PROMPT_EVENT_TYPES = new Set(['status_check_due', 'status_check_escalated']);
const ACTIVE_CHECK_STATES = new Set([
  'pending',
  'due',
  'awaiting',
  'awaiting_response',
  'active',
  'fired',
  'notified',
  'open',
  'escalated',
  'overdue',
  'expired',
  'unacknowledged',
  'alert',
]);
const SKIP_CHECK_STATES = new Set([
  'acknowledged',
  'ack',
  'acked',
  'snoozed',
  'cancelled',
  'canceled',
  'idle',
  'completed',
  'closed',
  'resolved',
]);

const POLL_INTERVAL_MS = 10000;
const POLL_LOOKAHEAD_SEC = 60;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_TIMEOUT_MS = 30000;
const DEDUP_TTL_MS = 5 * 60 * 1000;

function log(action, details = {}) {
  console.log(`[CAD-StatusCheck] ${new Date().toISOString()} | ${action}`, JSON.stringify(details));
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}

function sameIdentifier(left, right) {
  const a = clean(left);
  const b = clean(right);
  return !!(a && b && a.toUpperCase() === b.toUpperCase());
}

function canonicalEventType(rawType) {
  if (!rawType) return null;
  const type = String(rawType).toLowerCase();
  if (TERMINAL_EVENT_TYPES.has(type)) {
    if (type === 'status_check_snoozed') return 'status_check_snoozed';
    if (type === 'status_check_cancelled' || type === 'status_check_canceled') return 'status_check_cancelled';
    return 'status_check_acknowledged';
  }
  if (ESCALATED_EVENT_TYPES.has(type)) return 'status_check_escalated';
  if (FIRE_EVENT_TYPES.has(type)) return 'status_check_due';
  return null;
}

export function buildWsUrl(config = {}) {
  const cadUrl = clean(config.cadUrl || process.env.CAD_URL);
  const apiKey = clean(config.cadApiKey || process.env.CAD_API_KEY);
  const dispatchCenterId = clean(config.dispatchCenterId || process.env.CAD_DISPATCH_CENTER_ID);
  const agencyId = clean(config.agencyId || process.env.CAD_AGENCY_ID);
  if (!cadUrl || !apiKey || !dispatchCenterId) return null;
  const base = cadUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:').replace(/\/+$/, '');
  const params = new URLSearchParams({ api_key: apiKey, dispatch_center_id: dispatchCenterId });
  if (agencyId) params.set('agency_id', agencyId);
  return `${base}/ws?${params.toString()}`;
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  return {
    ...data,
    ...raw,
    unit_id: raw.unit_id || raw.unitId || data.unit_id || data.unitId || null,
    unit_number: raw.unit_number || raw.unitNumber || data.unit_number || data.unitNumber || null,
    call_id: raw.call_id || raw.callId || data.call_id || data.callId || null,
    assignment_id: raw.assignment_id || raw.assignmentId || data.assignment_id || data.assignmentId || null,
    check_id: raw.check_id || raw.checkId || data.check_id || data.checkId || raw.id || data.id || null,
    due_at: raw.due_at || raw.dueAt || data.due_at || data.dueAt || null,
    call_number: raw.call_number || raw.callNumber || data.call_number || data.callNumber || null,
    agency_id: raw.agency_id || raw.agencyId || data.agency_id || data.agencyId || null,
    dispatch_center_id:
      raw.dispatch_center_id || raw.dispatchCenterId || data.dispatch_center_id || data.dispatchCenterId || null,
    event: raw.event || raw.type || data.event || data.type || null,
    sequence: raw.sequence ?? raw.seq ?? data.sequence ?? data.seq ?? null,
    cycle: raw.cycle ?? data.cycle ?? null,
  };
}

function eventKey(event) {
  const cycle = event.cycle ?? event.sequence ?? event.check_id ?? event.due_at ?? '';
  return [
    event.event || '',
    event.assignment_id || '',
    event.unit_id || event.unit_number || '',
    event.call_id || '',
    cycle,
  ].join('|');
}

function extractChecks(result) {
  if (!result || result.success === false) return [];
  if (Array.isArray(result.pending_checks)) return result.pending_checks;
  if (Array.isArray(result.checks)) return result.checks;
  return [];
}

function extractCurrentCallId(result) {
  if (!result || typeof result !== 'object') return null;
  const call = result.call && typeof result.call === 'object' ? result.call : null;
  return clean(
    result.call_id || result.callId || call?.call_id || call?.callId || call?.id || result.id,
  );
}

function pendingCheckMatches(check, event) {
  const normalized = normalizeEvent(check);
  if (!normalized) return false;
  if (!sameIdentifier(normalized.call_id, event.call_id)) return false;

  const eventAssignment = clean(event.assignment_id);
  const checkAssignment = clean(normalized.assignment_id || normalized.check_id);
  if (eventAssignment && checkAssignment && !sameIdentifier(eventAssignment, checkAssignment)) return false;

  const eventUnitUuid = clean(event.unit_id);
  const checkUnitUuid = clean(normalized.unit_id);
  if (eventUnitUuid && checkUnitUuid && !sameIdentifier(eventUnitUuid, checkUnitUuid)) return false;

  const eventUnitNumber = clean(event.unit_number);
  const checkUnitNumber = clean(normalized.unit_number);
  if (eventUnitNumber && checkUnitNumber && !sameIdentifier(eventUnitNumber, checkUnitNumber)) return false;

  // A UUID match is strongest. If CAD omitted UUIDs, require an exact callsign match.
  const identityMatched =
    (eventUnitUuid && checkUnitUuid && sameIdentifier(eventUnitUuid, checkUnitUuid)) ||
    (eventUnitNumber && checkUnitNumber && sameIdentifier(eventUnitNumber, checkUnitNumber));
  if (!identityMatched) return false;

  const state = String(check.state || check.status || '').toLowerCase();
  return !state || ACTIVE_CHECK_STATES.has(state);
}

export class CadStatusCheckClient {
  constructor(config = {}) {
    this.config = { ...config };
    this.ws = null;
    this.handler = null;
    this.running = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
    this._pingTimer = null;
    this._pollTimer = null;
    this._seenKeys = new Map();
    this._inFlightKeys = new Set();
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
    log('START', {
      profileId: this.config.profileId || null,
      dispatchCenterId: this.config.dispatchCenterId || null,
      url: buildWsUrl(this.config)?.replace(/api_key=[^&]+/, 'api_key=***'),
    });
    this._connect();
    this._startPolling();
  }

  stop() {
    this.running = false;
    this.handler = null;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._pingTimer) clearTimeout(this._pingTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._pollTimer = null;
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this._seenKeys.clear();
    this._inFlightKeys.clear();
    this._selfRespondedCallIds.clear();
    log('STOPPED', { profileId: this.config.profileId || null });
  }

  markSelfResponded(unitForms, callId) {
    if (!callId) return;
    const forms = (Array.isArray(unitForms) ? unitForms : [unitForms]).filter(Boolean);
    const timestamp = Date.now();
    for (const form of forms) {
      const key = `${String(callId)}|${String(form).toUpperCase()}`;
      this._selfRespondedCallIds.set(key, timestamp);
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

  _runCad(operation) {
    return runWithRuntime(this.config, operation);
  }

  _connect() {
    const url = buildWsUrl(this.config);
    if (!url) {
      log('CONNECT_SKIPPED', { reason: 'no center-scoped CAD URL/key' });
      return;
    }

    try {
      this.ws = new WebSocket(url);
    } catch (error) {
      log('CONNECT_ERROR', { error: error.message });
      this._scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      log('CONNECTED', { profileId: this.config.profileId || null });
      this._reconnectAttempts = 0;
      this._armPingTimeout();
    });
    this.ws.on('ping', () => {
      try { this.ws?.pong(); } catch (_) {}
      this._armPingTimeout();
    });
    this.ws.on('pong', () => this._armPingTimeout());
    this.ws.on('message', (raw) => {
      this._armPingTimeout();
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        log('PARSE_ERROR', { error: error.message });
        return;
      }
      void this._handleEvent(message).catch((error) => {
        log('WS_EVENT_ERROR', { error: error.message });
      });
    });
    this.ws.on('close', (code, reason) => {
      log('CLOSED', { code, reason: reason?.toString() });
      if (this._pingTimer) clearTimeout(this._pingTimer);
      this._pingTimer = null;
      this.ws = null;
      if (this.running) this._scheduleReconnect();
    });
    this.ws.on('error', (error) => log('WS_ERROR', { error: error.message }));
  }

  _armPingTimeout() {
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._pingTimer = setTimeout(() => {
      log('PING_TIMEOUT', { ms: PING_TIMEOUT_MS });
      try { this.ws?.terminate(); } catch (_) {}
    }, PING_TIMEOUT_MS);
    this._pingTimer.unref?.();
  }

  _scheduleReconnect() {
    if (!this.running || this._reconnectTimer) return;
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this._reconnectAttempts += 1;
    log('RECONNECT_SCHEDULED', { attempt: this._reconnectAttempts, delayMs: delay });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (this.running) this._connect();
    }, delay);
    this._reconnectTimer.unref?.();
  }

  _startPolling() {
    void this._pollOnce();
    this._pollTimer = setInterval(() => void this._pollOnce(), POLL_INTERVAL_MS);
    this._pollTimer.unref?.();
  }

  async _pollOnce() {
    if (!this.running) return;
    try {
      const result = await this._runCad(() => cadService.getPendingChecks(POLL_LOOKAHEAD_SEC));
      const checks = extractChecks(result);
      const now = Date.now();
      log('POLL_RESULT', {
        count: checks.length,
        states: checks.map((check) => String(check.state || check.status || 'unknown').toLowerCase()),
      });

      for (const check of checks) {
        const state = String(check.state || check.status || '').toLowerCase();
        if (SKIP_CHECK_STATES.has(state)) continue;
        const dueAtRaw = check.due_at || check.dueAt;
        const dueAtMs = dueAtRaw ? new Date(dueAtRaw).getTime() : null;
        let eventType = null;
        if (['escalated', 'overdue', 'expired', 'unacknowledged', 'alert'].includes(state)) {
          eventType = 'status_check_escalated';
        } else if (ACTIVE_CHECK_STATES.has(state)) {
          if (dueAtMs == null || dueAtMs <= now || ['pending', 'escalated'].includes(state)) {
            eventType = state === 'escalated' ? 'status_check_escalated' : 'status_check_due';
          }
        } else if ((check.unit_id || check.unitId) && dueAtMs != null && dueAtMs <= now) {
          log('POLL_UNKNOWN_STATE', { state, callId: check.call_id || check.callId });
          eventType = 'status_check_due';
        }
        if (!eventType) continue;

        const synthesized = {
          ...check,
          event: eventType,
          unit_id: check.unit_id || check.unitId,
          unit_number: check.unit_number || check.unitNumber,
          call_id: check.call_id || check.callId,
          call_number: check.call_number || check.callNumber,
          assignment_id: check.assignment_id || check.assignmentId || check.id,
          check_id: check.check_id || check.checkId || check.id,
          due_at: dueAtRaw,
          source: 'poll',
        };
        await this._handleEvent(synthesized);
      }
    } catch (error) {
      log('POLL_ERROR', { error: error.message });
    }
  }

  async _validatePromptRecipient(event) {
    const managed = this.config.managed === true || !!this.config.profileId;
    const dispatchCenterId = clean(this.config.dispatchCenterId || process.env.CAD_DISPATCH_CENTER_ID);
    const callId = clean(event.call_id);
    const unitNumber = clean(event.unit_number);

    if (managed && !dispatchCenterId) {
      log('PROMPT_REJECTED', { reason: 'managed_profile_without_dispatch_center' });
      return false;
    }
    if (!callId) {
      log('PROMPT_REJECTED', {
        reason: managed ? 'managed_call_id_required' : 'call_id_required',
        unitId: event.unit_id || null,
        unitNumber,
      });
      return false;
    }
    if (!unitNumber) {
      log('PROMPT_REJECTED', { reason: 'unit_number_required', callId });
      return false;
    }

    try {
      // This center-scoped endpoint verifies both that the callsign belongs to
      // the selected CAD and that it is actively assigned to the exact call.
      const current = await this._runCad(() => cadService.getUnitCurrentCallById(unitNumber));
      const activeCallId = extractCurrentCallId(current);
      if (!current || current.has_active_call !== true || !sameIdentifier(activeCallId, callId)) {
        log('PROMPT_REJECTED', {
          reason: 'unit_not_active_on_exact_call',
          unitNumber,
          eventCallId: callId,
          activeCallId,
          hasActiveCall: current?.has_active_call === true,
          dispatchCenterId,
        });
        return false;
      }

      // Defense in depth: the exact pending assignment must still exist in the
      // same center at the moment we are about to speak. A stale WS event or a
      // cross-center assignment therefore cannot reach the radio channel.
      const pendingResult = await this._runCad(() => cadService.getPendingChecks(0));
      const pendingChecks = extractChecks(pendingResult);
      const exactPending = pendingChecks.some((check) => pendingCheckMatches(check, event));
      if (!exactPending) {
        log('PROMPT_REJECTED', {
          reason: 'exact_pending_assignment_not_found',
          unitId: event.unit_id || null,
          unitNumber,
          callId,
          assignmentId: event.assignment_id || null,
          dispatchCenterId,
        });
        return false;
      }
      return true;
    } catch (error) {
      // Never speak when verification is unavailable. Polling will retry after
      // CAD recovers, but the dispatcher will not guess across tenant borders.
      log('PROMPT_REJECTED', {
        reason: 'recipient_verification_failed',
        error: error.message,
        unitNumber,
        callId,
        dispatchCenterId,
      });
      return false;
    }
  }

  _evictSeen(now) {
    if (now - (this._lastEviction || 0) <= 60000) return;
    this._lastEviction = now;
    const cutoff = now - DEDUP_TTL_MS;
    for (const [key, timestamp] of this._seenKeys) {
      if (timestamp < cutoff) this._seenKeys.delete(key);
    }
  }

  async _handleEvent(rawEvent) {
    const event = normalizeEvent(rawEvent);
    if (!event?.event) return;
    const rawType = String(event.event).toLowerCase();
    if (!STATUS_CHECK_EVENTS.has(rawType) && !rawType.startsWith('status_check_')) return;
    const type = canonicalEventType(rawType);
    if (!type) return;
    event.event = type;

    const configuredCenter = clean(this.config.dispatchCenterId || process.env.CAD_DISPATCH_CENTER_ID);
    if (configuredCenter && event.dispatch_center_id && !sameIdentifier(configuredCenter, event.dispatch_center_id)) {
      log('CENTER_FILTERED', {
        eventCenter: event.dispatch_center_id,
        ourCenter: configuredCenter,
        callId: event.call_id || null,
      });
      return;
    }

    const configuredAgency = clean(this.config.agencyId || process.env.CAD_AGENCY_ID);
    if (configuredAgency && event.agency_id && !sameIdentifier(configuredAgency, event.agency_id)) {
      log('AGENCY_FILTERED', {
        eventAgency: event.agency_id,
        ourAgency: configuredAgency,
        callId: event.call_id || null,
      });
      return;
    }

    const key = eventKey(event);
    if (this._inFlightKeys.has(key)) return;
    this._inFlightKeys.add(key);
    try {
      if (PROMPT_EVENT_TYPES.has(type) && !(await this._validatePromptRecipient(event))) return;

      const now = Date.now();
      const previous = this._seenKeys.get(key);
      if (previous && now - previous < DEDUP_TTL_MS) return;
      this._seenKeys.set(key, now);
      this._evictSeen(now);

      const unitId = event.unit_id;
      const unitNumber = event.unit_number;
      const callId = event.call_id;
      if (type === 'status_check_acknowledged' && this._consumeSelfResponded([unitNumber, unitId], callId)) {
        log('ACK_SELF_SUPPRESSED', { unitId, unitNumber, callId });
        return;
      }

      log('EVENT_ACCEPTED', {
        type,
        unitId,
        unitNumber,
        callId,
        assignmentId: event.assignment_id || null,
        dispatchCenterId: configuredCenter,
        source: event.source || 'ws',
      });
      if (typeof this.handler === 'function') {
        await Promise.resolve(this.handler({ type, unitId, unitNumber, callId, raw: event }));
      }
    } catch (error) {
      log('HANDLER_ERROR', { error: error.message, type, callId: event.call_id || null });
    } finally {
      this._inFlightKeys.delete(key);
    }
  }
}

export const cadStatusCheckClient = new CadStatusCheckClient();
export default cadStatusCheckClient;
