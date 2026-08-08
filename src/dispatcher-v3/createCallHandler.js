import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

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
    const canonicalCity = clean(resolved.city) || spokenCity || null;
    const source = clean(resolution?.source);
    if (!canonicalAddress) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Command Link could not resolve a street address for ${query}`, { statusCode: 422, retryable: false, details: { correlationId, query, source } });

    const municipality = source === 'MAI' ? clean(resolved.municipality) : clean(input.municipality);

    return gateway.post('/api/radio/v3/cad/calls', {
      type: input.type,
      location: canonicalAddress,
      apt: input.apt || clean(resolved.apartmentUnit) || undefined,
      city: canonicalCity || undefined,
      state: input.state || clean(resolved.state) || undefined,
      zip: input.zip || clean(resolved.zipCode) || undefined,
      county: input.county || clean(resolved.county) || undefined,
      municipality: municipality || undefined,
      priority: input.priority || undefined,
      description: input.description || undefined,
      caller_name: input.callerName || undefined,
      callback_number: input.callerPhone || undefined,
      zone: input.zone || undefined,
      latitude: input.latitude || resolved.latitude || undefined,
      longitude: input.longitude || resolved.longitude || undefined,
      cross_street_1: input.crossStreet1 || undefined,
      cross_street_2: input.crossStreet2 || undefined,
      location_address_id: input.locationAddressId || resolved.id || undefined,
      security_client_id: input.securityClientId || undefined,
      security_client_site_id: input.securityClientSiteId || undefined,
      units: callsigns,
    }, { correlationId, timeoutMs: CREATE_CALL_TIMEOUT_MS });
  };
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}

export const __createCallHandlerTest = { CREATE_CALL_TIMEOUT_MS };
