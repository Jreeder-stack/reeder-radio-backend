import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const TERMINAL_CALL_STATUSES = new Set(['cleared', 'closed', 'cancelled', 'canceled', 'voided', 'disposed']);
const CURRENT_CALL_REFS = new Set([
  'my call', 'our call', 'my current call', 'our current call', 'current call',
  'the call im on', 'call im on', 'the call i am on', 'call i am on',
  'the call were on', 'call were on', 'the call we are on', 'call we are on',
  'this call', 'my incident', 'our incident', 'current incident',
]);
const GENERIC_CALL_REFS = new Set([
  'call', 'the call', 'that call', 'that one', 'the only call', 'only call',
  'the call holding', 'call holding', 'the pending call', 'pending call',
  'the open call', 'open call', 'the active call', 'active call',
]);
const CALL_REFERENCE_STOPWORDS = new Set([
  'the', 'a', 'an', 'call', 'calls', 'incident', 'incidents', 'job', 'jobs',
  'event', 'events', 'that', 'this', 'one', 'at', 'on', 'for', 'from', 'of',
]);

export class V3OperationalContextService {
  constructor({ gateway, unitIdentityService } = {}) {
    if (!gateway) throw new TypeError('gateway is required');
    if (!unitIdentityService) throw new TypeError('unitIdentityService is required');
    this.gateway = gateway;
    this.unitIdentityService = unitIdentityService;
  }

  async snapshot({ speakerCallsign, correlationId } = {}) {
    const identity = await this.unitIdentityService.resolve(speakerCallsign, { correlationId });
    const [currentCall, activeCalls, units] = await Promise.all([
      this._getCurrentCall(identity.callsign, correlationId),
      this._getActiveCalls(correlationId),
      this._getUnits(correlationId),
    ]);

    return Object.freeze({
      speaker: Object.freeze({
        unitId: identity.unitId,
        callsign: identity.callsign,
        status: identity.status || null,
        agencyId: identity.agencyId || null,
      }),
      currentCall: currentCall ? Object.freeze(sanitizeCall(currentCall)) : null,
      activeCalls: Object.freeze(activeCalls.map((call) => Object.freeze(sanitizeCall(call)))),
      units: Object.freeze(units.map((unit) => Object.freeze(sanitizeUnit(unit)))),
    });
  }

  async resolveCallId({ callId = null, callRef = null, operationalContext = null, preferCurrentCall = false, correlationId } = {}) {
    if (clean(callId)) return clean(callId);

    const ref = normalize(callRef);
    const currentCallId = clean(operationalContext?.currentCall?.id);

    // Explicit self/current-call language is authoritative when the transmitting
    // unit is actually assigned to a current call. This must beat unrelated
    // active calls in the center.
    if (ref && isCurrentCallReference(ref) && currentCallId) return currentCallId;
    if (!ref && preferCurrentCall && currentCallId) return currentCallId;

    const calls = Array.isArray(operationalContext?.activeCalls)
      ? operationalContext.activeCalls
      : await this._getActiveCalls(correlationId);

    if (calls.length === 0) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND, 'There are no active calls in the selected dispatch center', { statusCode: 404 });
    }

    // Demonstratives such as "that call" are safe only when the center context
    // makes the target unique. Do not silently turn them into the speaker's call
    // when several plausible calls exist.
    if (!ref || isGenericCallReference(ref)) {
      if (calls.length === 1) return getCallId(calls[0]);
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CALL_AMBIGUOUS,
        'More than one active call is available and the call reference is not unique',
        { statusCode: 409, details: { callRef: clean(callRef), candidates: calls.map(sanitizeCall) } },
      );
    }

    const searchableRef = simplifyCallReference(ref);
    const ranked = calls
      .map((call) => ({ call, score: scoreCallReference(call, ref, searchableRef) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND, `No active call matched ${callRef}`, { statusCode: 404 });
    }

    const bestScore = ranked[0].score;
    const best = ranked.filter((entry) => entry.score === bestScore);
    if (best.length !== 1) {
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CALL_AMBIGUOUS,
        `More than one active call matched ${callRef}`,
        { statusCode: 409, details: { candidates: best.map((entry) => sanitizeCall(entry.call)) } },
      );
    }

    return getCallId(best[0].call);
  }

  async _getActiveCalls(correlationId) {
    const response = await this.gateway.get('/api/radio/calls', { correlationId });
    const calls = Array.isArray(response?.calls) ? response.calls : [];
    return calls.filter((call) => {
      const status = normalize(call?.status);
      return !status || !TERMINAL_CALL_STATUSES.has(status);
    }).filter((call) => Boolean(getCallId(call)));
  }

  async _getUnits(correlationId) {
    const response = await this.gateway.get('/api/radio/status-check', { correlationId });
    const units = Array.isArray(response?.units) ? response.units : [];
    return units.filter((unit) => clean(unit?.unit_id || unit?.unitId || unit?.callsign));
  }

  async _getCurrentCall(callsign, correlationId) {
    try {
      const response = await this.gateway.get(`/api/radio/unit/${encodeURIComponent(callsign)}/call`, { correlationId });
      const call = response?.call || response?.assignment?.call || response?.assignment || null;
      return call && getCallId(call) ? call : null;
    } catch (error) {
      const status = Number(error?.statusCode);
      if (status === 404) return null;
      throw error;
    }
  }
}

export function sanitizeV3OperationalContext(context) {
  if (!context || typeof context !== 'object') return null;
  return {
    speaker: context.speaker ? {
      unitId: clean(context.speaker.unitId),
      callsign: clean(context.speaker.callsign),
      status: clean(context.speaker.status),
    } : null,
    currentCall: context.currentCall ? sanitizeCall(context.currentCall) : null,
    activeCalls: Array.isArray(context.activeCalls) ? context.activeCalls.slice(0, 20).map(sanitizeCall) : [],
    units: Array.isArray(context.units) ? context.units.slice(0, 100).map(sanitizeUnit) : [],
  };
}

function scoreCallReference(call, rawRef, simplifiedRef = rawRef) {
  const ref = normalize(rawRef);
  const simple = normalize(simplifiedRef) || ref;
  const id = normalize(getCallId(call));
  const number = normalize(call?.call_number || call?.callNumber || call?.number);
  const nature = normalize(call?.nature || call?.type || call?.call_type);
  const location = normalize(call?.location || call?.address || call?.location_name);
  const municipality = normalize(call?.municipality || call?.city);
  const caller = normalize(call?.caller_name || call?.callerName || call?.caller);
  const description = normalize(call?.description || call?.details || call?.notes_summary);
  const combined = [number, nature, location, municipality, caller, description].filter(Boolean).join(' ');

  if (ref === id || ref === number || simple === id || simple === number) return 100;
  if (number && (number.includes(simple) || simple.includes(number))) return 92;
  if (nature && nature === simple) return 86;
  if (location && location === simple) return 86;
  if (caller && caller === simple) return 86;
  if (nature && (nature.includes(simple) || simple.includes(nature))) return 76;
  if (location && (location.includes(simple) || simple.includes(location))) return 76;
  if (caller && (caller.includes(simple) || simple.includes(caller))) return 76;
  if (combined.includes(simple)) return 66;

  const words = referenceWords(simple);
  if (words.length > 0) {
    const matched = words.filter((word) => combined.includes(word)).length;
    if (matched === words.length) return 55 + Math.min(10, matched);
    if (matched > 0) return 20 + matched;
  }
  return 0;
}

function sanitizeCall(call) {
  return {
    id: getCallId(call),
    callNumber: clean(call?.call_number || call?.callNumber || call?.number),
    nature: clean(call?.nature || call?.type || call?.call_type),
    location: clean(call?.location || call?.address || call?.location_name),
    municipality: clean(call?.municipality || call?.city),
    status: clean(call?.status),
    priority: clean(call?.priority),
    callerName: clean(call?.caller_name || call?.callerName || call?.caller),
    description: clean(call?.description || call?.details || call?.notes_summary),
  };
}

function sanitizeUnit(unit) {
  return {
    callsign: clean(unit?.callsign || unit?.unit_id || unit?.unitId || unit?.unit_number || unit?.unitNumber),
    name: clean(unit?.name),
    status: clean(unit?.status),
    zone: clean(unit?.zone),
    agency: clean(unit?.agency),
    location: clean(unit?.location || unit?.current_location || unit?.currentLocation),
  };
}

function getCallId(call) {
  return clean(call?.id || call?.call_id || call?.callId || call?.uuid);
}

function isCurrentCallReference(ref) {
  return CURRENT_CALL_REFS.has(ref) || /^(?:my|our)\s+(?:current\s+)?(?:call|incident)$/.test(ref)
    || /^(?:the\s+)?(?:call|incident)\s+(?:i(?:\s+am|m)|we(?:\s+are|re))\s+on$/.test(ref);
}

function isGenericCallReference(ref) {
  return GENERIC_CALL_REFS.has(ref);
}

function simplifyCallReference(ref) {
  const possessiveNormalized = String(ref || '').replace(/\b([a-z0-9]+)\s+s\b/g, '$1');
  const words = possessiveNormalized.split(' ').filter(Boolean);
  const filtered = words.filter((word) => !CALL_REFERENCE_STOPWORDS.has(word));
  return filtered.join(' ').trim() || ref;
}

function referenceWords(ref) {
  return String(ref || '').split(' ').filter((word) => word.length >= 2 && !CALL_REFERENCE_STOPWORDS.has(word));
}

function normalize(value) {
  return clean(value)?.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim() || null;
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
