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
  'near', 'in', 'by', 'about', 'reported', 'report', 'please', 'number', 'no',
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
    const currentIsActive = currentCallId && Array.isArray(operationalContext?.activeCalls)
      && operationalContext.activeCalls.some(call => clean(call?.id) === currentCallId
        && !TERMINAL_CALL_STATUSES.has(normalize(call.status)));

    // Explicit "my call" cannot quietly fall back to a different call
    // when the assignment has expired, changed or was not loaded.
    if (ref && isCurrentCallReference(ref)) {
      if (currentIsActive) return currentCallId;
      throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND,
        'No verified active current call is assigned to the transmitting unit', { statusCode: 404 });
    }
    if (!ref && preferCurrentCall && currentIsActive) return currentCallId;

    const calls = Array.isArray(operationalContext?.activeCalls)
      ? operationalContext.activeCalls
      : await this._getActiveCalls(correlationId);

    if (calls.length === 0) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND, 'There are no active calls in the selected dispatch center', { statusCode: 404 });
    }

    if (!ref || isGenericCallReference(ref)) {
      if (calls.length === 1) return getCallId(calls[0]);
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CALL_AMBIGUOUS,
        'More than one active call is available and the call reference is not unique',
        { statusCode: 409, details: { callRef: clean(callRef), candidates: calls.map(sanitizeCall) } },
      );
    }

    // Resolve only against complete, non-conflicting authoritative fields.
    // A partially overlapping location never overrides a contradictory nature:
    // "Walmart robbery" must not select "ALARM at Walmart".
    const words = referenceWords(simplifyCallReference(ref));
    if (!words.length) throw new DispatcherV3Error(V3_ERROR_CODES.CALL_AMBIGUOUS,
      'The incident reference needs a call number, nature or location', { statusCode: 409 });
    const ranked = calls.map(call => ({ call, score: scoreCallEvidence(call, words, ref) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score);
    if (!ranked.length) throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND,
      `No active call matches all details of ${callRef}`, { statusCode: 404, details: { callRef: clean(callRef), candidates: [] } });
    const best = ranked.filter(candidate => candidate.score === ranked[0].score);
    if (best.length !== 1) throw new DispatcherV3Error(V3_ERROR_CODES.CALL_AMBIGUOUS,
      `More than one active call matches ${callRef}`, {
        statusCode: 409, details: { callRef: clean(callRef), candidates: best.map(entry => sanitizeCall(entry.call)) },
      });
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


// 02-05: fail closed against FRESH center-scoped CAD state, not the context
// captured when an earlier prompt was composed. This validates a pending
// implicit follow-up only; an independently authorized explicit historical
// call reference uses the ordinary CAD resolver and action permissions.
export function assertV3CurrentTaskCall({
  operationalContext, expectedCallId, expectedUnitId = null, allowUnassigned = false,
} = {}) {
  if (!operationalContext?.speaker?.unitId || !Array.isArray(operationalContext.activeCalls)) {
    throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE,
      'Current CAD assignment and active call data could not be verified', { statusCode: 503, retryable: true });
  }
  const current = clean(operationalContext.currentCall?.id);
  const expected = clean(expectedCallId);
  const identity = clean(operationalContext.speaker.unitId);
  const changed = (reason) => {
    throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
      'The previous task no longer matches the unit\'s active CAD assignment', {
        statusCode: 409, details: { reason, expectedCallId: expected, currentCallId: current },
      });
  };

  if (expectedUnitId && identity !== clean(expectedUnitId)) changed('speaker_identity_changed');
  if (!expected) {
    if (!allowUnassigned) changed('target_missing');
    if (current) changed('new_assignment');
    return { currentCallId: null, active: true };
  }
  if (current !== expected) changed(current ? 'reassigned' : 'unassigned');
  const listed = operationalContext.activeCalls.find((call) => clean(call?.id) === expected);
  const closed = (status) => TERMINAL_CALL_STATUSES.has(normalize(status));
  if (closed(operationalContext.currentCall?.status) || !listed || closed(listed.status)) {
    changed('target_not_active');
  }
  return { currentCallId: expected, active: true };
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

// Every meaningful supplied word must match an authoritative field as a WHOLE
// word. Matching merely one word, substring or a free-text description is not
// enough evidence for a public-safety incident selection.
function scoreCallEvidence(call, words, normalizedRef) {
  const id = normalize(getCallId(call));
  const number = normalize(call?.call_number || call?.callNumber || call?.number);
  if (normalizedRef === id || normalizedRef === number) return 1000;
  const categories = [
    normalize(call?.nature || call?.type || call?.call_type),
    normalize(call?.location || call?.address || call?.location_name),
    normalize(call?.municipality || call?.city),
    normalize(call?.caller_name || call?.callerName || call?.caller),
    number,
  ].filter(Boolean).map(field => new Set(field.split(' ').filter(Boolean)));
  if (!categories.length || !words.every(word => categories.some(tokens => tokens.has(word)))) return 0;
  // Prefer multiple independently corroborating structured facts. Ties are
  // ambiguous rather than guesses; the model cannot raise the score.
  const matchingFields = categories.filter(tokens => words.some(word => tokens.has(word))).length;
  return words.length * 10 + matchingFields;
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
    // Description may contain unverified free text. It is context for a
    // human, not evidence that can override structured call nature/location.
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
  const words = String(ref || '').split(' ').filter(Boolean);
  if (words.length >= 2 && /^(?:call|incident|job|event)s?$/.test(words[words.length - 1]) && /s$/.test(words[0]) && words[0].length > 2) {
    words[0] = words[0].slice(0, -1);
  }
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
