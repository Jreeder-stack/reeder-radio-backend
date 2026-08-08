import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const TERMINAL_CALL_STATUSES = new Set(['cleared', 'closed', 'cancelled']);

export async function readCallForVerification(gateway, callId, correlationId) {
  const response = await gateway.get(`/api/radio/v3/cad/calls/${encodeURIComponent(callId)}`, { correlationId });
  const call = response?.call || null;
  if (!call || String(call.call_id || '') !== String(callId)) {
    throw verificationError('Command Link did not return the expected call during write verification', {
      callId, response: response || null,
    });
  }
  return call;
}

export async function readUnitForVerification(gateway, callsign, correlationId) {
  const response = await gateway.get('/api/radio/status-check', { correlationId });
  const units = Array.isArray(response?.units) ? response.units : [];
  const wanted = normalize(callsign);
  const unit = units.find((candidate) => normalize(candidate?.unit_id || candidate?.callsign || candidate?.unit_number) === wanted);
  if (!unit) {
    throw verificationError(`Command Link did not return ${callsign} during unit write verification`, { callsign });
  }
  return unit;
}

export function verifyUnitStatus(unit, requestedStatus, details = {}) {
  const actual = normalizeStatus(unit?.status || unit?.current_status || unit?.currentStatus);
  const expected = normalizeStatus(requestedStatus);
  if (!actual || actual !== expected) {
    throw verificationError(`Command Link did not confirm unit status ${expected}`, { ...details, expected, actual, unit });
  }
  return unit;
}

export function verifyUnitZone(unit, requestedZone, details = {}) {
  const actual = normalize(unit?.zone);
  const expected = normalize(requestedZone);
  if (!actual || actual !== expected) {
    throw verificationError(`Command Link did not confirm unit zone ${requestedZone}`, { ...details, expected, actual, unit });
  }
  return unit;
}

export function verifyCallMutation(call, input, details = {}) {
  const mappings = {
    type: ['type', 'nature'], location: ['location'], apt: ['apt'], city: ['city'], state: ['state'], zip: ['zip'], county: ['county'],
    municipality: ['municipality'], zone: ['zone'], latitude: ['latitude'], longitude: ['longitude'], crossStreet1: ['cross_street_1'],
    crossStreet2: ['cross_street_2'], priority: ['priority'], status: ['status'], description: ['description'], callerName: ['caller_name'],
    callerPhone: ['callback_number'], locationAddressId: ['location_address_id'], securityClientId: ['security_client_id'],
    securityClientSiteId: ['security_client_site_id'], disposition: ['disposition'], dispositionNotes: ['disposition_notes'],
  };
  for (const [inputKey, callKeys] of Object.entries(mappings)) {
    if (input[inputKey] === undefined || input[inputKey] === null) continue;
    const actual = firstValue(call, callKeys);
    if (!equivalent(input[inputKey], actual, inputKey)) {
      throw verificationError(`Command Link did not confirm call field ${inputKey}`, {
        ...details, field: inputKey, expected: input[inputKey], actual, call,
      });
    }
  }
  return call;
}

export function verifyUnitAssigned(call, identity, shouldBeAssigned, details = {}) {
  const units = Array.isArray(call?.assigned_units) ? call.assigned_units : [];
  const present = units.some((unit) => unitMatches(unit, identity));
  if (present !== shouldBeAssigned) {
    throw verificationError(`Command Link did not confirm ${identity.callsign || identity.unitId} was ${shouldBeAssigned ? 'assigned to' : 'removed from'} the call`, {
      ...details, unitId: identity.unitId, callsign: identity.callsign, assignedUnits: units,
    });
  }
  return call;
}

export function verifyPrimaryUnit(call, identity, details = {}) {
  const primary = call?.primary_unit || null;
  if (!primary || !unitMatches(primary, identity)) {
    throw verificationError(`Command Link did not confirm ${identity.callsign || identity.unitId} as primary`, {
      ...details, unitId: identity.unitId, callsign: identity.callsign, primary,
    });
  }
  return call;
}

export function verifyAssignmentTimes(call, identity, requested, details = {}) {
  const units = Array.isArray(call?.assigned_units) ? call.assigned_units : [];
  const assignment = units.find((unit) => unitMatches(unit, identity));
  if (!assignment) throw verificationError('Command Link did not return the assignment during timestamp verification', { ...details, identity });
  const mapping = { assignedAt: 'assigned_at', dispatchedAt: 'dispatched_at', arrivedAt: 'arrived_at', ondtAt: 'ondt_at' };
  for (const [source, target] of Object.entries(mapping)) {
    if (requested[source] === undefined || requested[source] === null) continue;
    if (!sameInstant(requested[source], assignment[target])) {
      throw verificationError(`Command Link did not confirm assignment timestamp ${source}`, {
        ...details, field: source, expected: requested[source], actual: assignment[target], assignment,
      });
    }
  }
  return call;
}

export function verifyCallNote(call, note, details = {}) {
  const wanted = String(note || '').trim();
  const notes = Array.isArray(call?.call_notes) ? call.call_notes : [];
  const found = notes.some((item) => String(item?.text || '').trim() === wanted);
  if (!found) throw verificationError('Command Link did not confirm the call note was recorded', { ...details, note: wanted });
  return call;
}

export function verifyCallClosed(call, requestedDisposition = null, details = {}) {
  const status = normalizeStatus(call?.status);
  if (!TERMINAL_CALL_STATUSES.has(status)) {
    throw verificationError('Command Link did not confirm the call entered a terminal status', { ...details, status, call });
  }
  if (requestedDisposition && !equivalent(requestedDisposition, call?.disposition, 'disposition')) {
    throw verificationError('Command Link did not confirm the requested call disposition', {
      ...details, expected: requestedDisposition, actual: call?.disposition, call,
    });
  }
  return call;
}

function verificationError(message, details) {
  return new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, message, {
    statusCode: 502,
    retryable: false,
    details: details || null,
  });
}

function firstValue(object, keys) {
  for (const key of keys) if (object?.[key] !== undefined) return object[key];
  return undefined;
}

function equivalent(expected, actual, field) {
  if (field === 'latitude' || field === 'longitude') {
    const a = Number(expected); const b = Number(actual);
    return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.000001;
  }
  if (field === 'status') return normalizeStatus(expected) === normalizeStatus(actual);
  return normalize(expected) === normalize(actual);
}

function sameInstant(expected, actual) {
  const a = new Date(expected).getTime();
  const b = new Date(actual).getTime();
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function unitMatches(candidate, identity) {
  const wanted = new Set([normalize(identity?.unitId), normalize(identity?.callsign)].filter(Boolean));
  const values = [candidate?.unit_id, candidate?.unitId, candidate?.user_id, candidate?.userId, candidate?.id, candidate?.callsign, candidate?.unit_number, candidate?.unitNumber]
    .map(normalize).filter(Boolean);
  return values.some((value) => wanted.has(value));
}

function normalize(value) { return value === undefined || value === null ? '' : String(value).trim().toUpperCase(); }
function normalizeStatus(value) { return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); }
