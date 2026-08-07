import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const TERMINAL_CALL_STATUSES = new Set(['cleared', 'closed', 'cancelled', 'canceled', 'voided', 'disposed']);

export class V3OperationalContextService {
  constructor({ gateway, unitIdentityService } = {}) {
    if (!gateway) throw new TypeError('gateway is required');
    if (!unitIdentityService) throw new TypeError('unitIdentityService is required');
    this.gateway = gateway;
    this.unitIdentityService = unitIdentityService;
  }

  async snapshot({ speakerCallsign, correlationId } = {}) {
    const identity = await this.unitIdentityService.resolve(speakerCallsign, { correlationId });
    const [currentCall, activeCalls] = await Promise.all([
      this._getCurrentCall(identity.callsign, correlationId),
      this._getActiveCalls(correlationId),
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
    });
  }

  async resolveCallId({ callId = null, callRef = null, operationalContext = null, correlationId } = {}) {
    if (clean(callId)) return clean(callId);

    const calls = Array.isArray(operationalContext?.activeCalls)
      ? operationalContext.activeCalls
      : await this._getActiveCalls(correlationId);

    if (calls.length === 0) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND, 'There are no active calls in the selected dispatch center', { statusCode: 404 });
    }

    const ref = normalize(callRef);
    if (!ref) {
      if (calls.length === 1) return getCallId(calls[0]);
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CALL_AMBIGUOUS,
        'More than one active call is available and no call reference was provided',
        { statusCode: 409, details: { candidates: calls.map(sanitizeCall) } },
      );
    }

    const ranked = calls
      .map((call) => ({ call, score: scoreCallReference(call, ref) }))
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
  };
}

function scoreCallReference(call, ref) {
  const id = normalize(getCallId(call));
  const number = normalize(call?.call_number || call?.callNumber || call?.number);
  const nature = normalize(call?.nature || call?.type || call?.call_type);
  const location = normalize(call?.location || call?.address || call?.location_name);
  const municipality = normalize(call?.municipality || call?.city);
  const combined = [number, nature, location, municipality].filter(Boolean).join(' ');

  if (ref === id || ref === number) return 100;
  if (number && number.includes(ref)) return 90;
  if (nature && nature === ref) return 80;
  if (location && location === ref) return 80;
  if (nature && (nature.includes(ref) || ref.includes(nature))) return 70;
  if (location && (location.includes(ref) || ref.includes(location))) return 70;
  if (combined.includes(ref)) return 60;

  const words = ref.split(' ').filter((word) => word.length >= 3);
  if (words.length > 0) {
    const matched = words.filter((word) => combined.includes(word)).length;
    if (matched === words.length) return 50 + matched;
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
  };
}

function getCallId(call) {
  return clean(call?.id || call?.call_id || call?.callId || call?.uuid);
}

function normalize(value) {
  return clean(value)?.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || null;
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
