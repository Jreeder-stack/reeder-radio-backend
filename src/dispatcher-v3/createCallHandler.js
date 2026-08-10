import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { readCallForVerification, verifyCallMutation, verifyUnitAssigned } from './cadMutationVerifier.js';

const CREATE_CALL_TIMEOUT_MS = 20000;

export function createResolvedCallHandler({ gateway, resolveSafeCallsign } = {}) {
  if (!gateway) throw new TypeError('gateway is required');
  if (typeof resolveSafeCallsign !== 'function') throw new TypeError('resolveSafeCallsign is required');

  return async ({ input, correlationId }) => {
    const callsigns = [];
    for (const unitId of input.unitIds || []) callsigns.push(await resolveSafeCallsign(unitId, correlationId));

    const spokenLocation = String(input.location || '').trim();
    const spokenCity = String(input.city || '').trim();
    const query = [spokenLocation, spokenCity].filter(Boolean).join(', ');
    if (!query) throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'A location is required to create a call', { statusCode: 400, retryable: false });

    let resolution;
    try {
      resolution = await gateway.get('/api/radio/locations/resolve', { correlationId, query: { q: query } });
    } catch (error) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Unable to verify call location: ${query}`, {
        statusCode: Number(error?.statusCode) || 422,
        retryable: error?.retryable === true,
        cause: error,
        details: { correlationId, query, originalError: error?.message || null },
      });
    }

    const resolved = resolution?.location || {};
    const canonicalAddress = clean(resolved.address);
    const canonicalCity = clean(resolved.city) || clean(resolved.municipality) || spokenCity || null;
    const source = clean(resolution?.source);
    if (!canonicalAddress) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Command Link could not resolve a street address for ${query}`, { statusCode: 422, retryable: false, details: { correlationId, query, source } });

    const municipality = clean(resolved.municipality) || clean(input.municipality);
    const requestBody = {
      type: input.type,
      location: canonicalAddress,
      apt: input.apt || clean(resolved.apartmentUnit) || undefined,
      city: canonicalCity || undefined,
      state: clean(resolved.state) || input.state || undefined,
      zip: clean(resolved.zipCode || resolved.zip) || input.zip || undefined,
      county: clean(resolved.county) || input.county || undefined,
      municipality: municipality || undefined,
      priority: input.priority || undefined,
      description: input.description || undefined,
      caller_name: input.callerName || undefined,
      callback_number: input.callerPhone || undefined,
      zone: input.zone || undefined,
      latitude: resolved.latitude || input.latitude || undefined,
      longitude: resolved.longitude || input.longitude || undefined,
      cross_street_1: clean(resolved.crossStreet1 || resolved.cross_street_1) || input.crossStreet1 || undefined,
      cross_street_2: clean(resolved.crossStreet2 || resolved.cross_street_2) || input.crossStreet2 || undefined,
      location_address_id: resolved.id || input.locationAddressId || undefined,
      security_client_id: input.securityClientId || undefined,
      security_client_site_id: input.securityClientSiteId || undefined,
      units: callsigns,
    };

    const created = await gateway.post('/api/radio/v3/cad/calls', requestBody, { correlationId, timeoutMs: CREATE_CALL_TIMEOUT_MS });
    const callId = created?.call?.call_id || created?.call?.id || created?.call_id || null;
    if (!callId) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, 'Command Link created a call but did not return a call identifier for verification', {
        statusCode: 502, retryable: false, details: { correlationId, response: created || null },
      });
    }

    const call = await readCallForVerification(gateway, callId, correlationId);
    verifyCallMutation(call, {
      type: input.type,
      location: canonicalAddress,
      apt: requestBody.apt,
      city: canonicalCity,
      state: requestBody.state,
      zip: requestBody.zip,
      county: requestBody.county,
      municipality: requestBody.municipality,
      priority: requestBody.priority,
      description: requestBody.description,
      callerName: requestBody.caller_name,
      callerPhone: requestBody.callback_number,
      zone: requestBody.zone,
      latitude: requestBody.latitude,
      longitude: requestBody.longitude,
      crossStreet1: requestBody.cross_street_1,
      crossStreet2: requestBody.cross_street_2,
      locationAddressId: requestBody.location_address_id,
      securityClientId: requestBody.security_client_id,
      securityClientSiteId: requestBody.security_client_site_id,
      status: callsigns.length ? 'assigned' : 'pending',
    }, { correlationId, callId });
    for (const callsign of callsigns) verifyUnitAssigned(call, { callsign }, true, { correlationId, callId });

    return { success: true, verified: true, call };
  };
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

export const __createCallHandlerTest = { CREATE_CALL_TIMEOUT_MS };
