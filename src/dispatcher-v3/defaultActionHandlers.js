import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { V3_ACTIONS } from './actionContracts.js';
import { createResolvedCallHandler } from './createCallHandler.js';
import {
  readCallForVerification,
  readUnitForVerification,
  verifyAssignmentTimes,
  verifyCallClosed,
  verifyCallMutation,
  verifyCallNote,
  verifyPrimaryUnit,
  verifyUnitAssigned,
  verifyUnitStatus,
  verifyUnitZone,
} from './cadMutationVerifier.js';

const CAD_PARITY_PREFIX = '/api/radio/v3/cad';

export function createDefaultV3ActionHandlers({ gateway, unitIdentityService, operationalAlertService = null, now = () => new Date() } = {}) {
  if (!gateway) throw new TypeError('gateway is required');
  if (!unitIdentityService) throw new TypeError('unitIdentityService is required');

  const resolveSafeIdentity = async (unitId, correlationId) => {
    const byId = await unitIdentityService.resolve(unitId, { correlationId });
    const byCallsign = await unitIdentityService.resolve(byId.callsign, { correlationId });
    if (byCallsign.unitId !== byId.unitId) {
      throw new DispatcherV3Error(V3_ERROR_CODES.UNIT_AMBIGUOUS, `Unit callsign ${byId.callsign} is not uniquely safe for execution`, {
        statusCode: 409, details: { unitId: byId.unitId, callsign: byId.callsign },
      });
    }
    return byId;
  };

  const resolveSafeCallsign = async (unitId, correlationId) => (await resolveSafeIdentity(unitId, correlationId)).callsign;
  const requireOperationalAlerts = () => {
    if (!operationalAlertService) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, 'Command Comms operational alert service is not available', { statusCode: 503, retryable: true });
    return operationalAlertService;
  };

  const recordOperationalNote = async ({ callId, note, correlationId }) => {
    if (!callId) return { recorded: false, skipped: true };
    try {
      await gateway.post('/api/radio/note', { call_id: callId, note }, { correlationId });
      const call = await readCallForVerification(gateway, callId, correlationId);
      verifyCallNote(call, note, { correlationId, callId });
      return { recorded: true, skipped: false, verified: true };
    } catch (error) {
      return { recorded: false, skipped: false, error: { code: error?.code || V3_ERROR_CODES.CAD_REJECTED, message: error?.message || 'Failed to record operational alert note' } };
    }
  };

  const createCall = createResolvedCallHandler({ gateway, resolveSafeCallsign });

  return {
    [V3_ACTIONS.RADIO_CHECK]: async ({ input }) => ({ unitId: input.unitId || null, acknowledged: true }),
    [V3_ACTIONS.TIME_CHECK]: async ({ input }) => ({ unitId: input.unitId || null, timestamp: now().toISOString() }),

    [V3_ACTIONS.SET_UNIT_STATUS]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      await gateway.post('/api/radio/status', { unit_id: identity.callsign, status: input.status, note: input.note || undefined }, { correlationId });
      const unit = await readUnitForVerification(gateway, identity.callsign, correlationId);
      verifyUnitStatus(unit, input.status, { correlationId, unitId: identity.unitId, callsign: identity.callsign });
      return { success: true, verified: true, unit };
    },

    [V3_ACTIONS.CHANGE_UNIT_ZONE]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      await gateway.post('/api/radio/zone', { unit_id: identity.callsign, zone: input.zone }, { correlationId });
      const unit = await readUnitForVerification(gateway, identity.callsign, correlationId);
      verifyUnitZone(unit, input.zone, { correlationId, unitId: identity.unitId, callsign: identity.callsign });
      return { success: true, verified: true, unit };
    },

    [V3_ACTIONS.GET_CURRENT_CALL]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.get(`/api/radio/unit/${encodeURIComponent(callsign)}/call`, { correlationId });
    },

    [V3_ACTIONS.GET_CALL]: async ({ input, correlationId }) =>
      gateway.get(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}`, { correlationId }),

    [V3_ACTIONS.LIST_ACTIVE_CALLS]: async ({ correlationId }) => {
      const response = await gateway.get('/api/radio/calls', { correlationId });
      const calls = Array.isArray(response?.calls) ? response.calls : [];
      return { calls, count: calls.length };
    },

    [V3_ACTIONS.SEARCH_CALLS]: async ({ input, correlationId }) => {
      const query = {
        q: input.query || undefined,
        call_number: input.callNumber || undefined,
        address: input.address || undefined,
        nature: input.nature || undefined,
        caller: input.caller || undefined,
        status: input.status || undefined,
        priority: input.priority || undefined,
        date_from: input.dateFrom || undefined,
        date_to: input.dateTo || undefined,
      };
      if (input.unitId) query.officer = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.get(`${CAD_PARITY_PREFIX}/calls`, { correlationId, query });
    },

    [V3_ACTIONS.CREATE_CALL]: createCall,

    [V3_ACTIONS.UPDATE_CALL]: async ({ input, correlationId }) => {
      const resolvedInput = await resolveLocationMutation(gateway, input, correlationId);
      const body = toCadCallMutation(resolvedInput);
      await gateway.patch(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}`, body, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyCallMutation(call, resolvedInput, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.ADD_CALL_NOTE]: async ({ input, correlationId }) => {
      await gateway.post('/api/radio/note', { call_id: input.callId, note: input.note, unit_id: input.unitId || undefined }, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyCallNote(call, input.note, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.ASSIGN_UNIT]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      await gateway.post('/api/radio/assign', { call_id: input.callId, unit_id: identity.callsign }, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyUnitAssigned(call, identity, true, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.UNASSIGN_UNIT]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      await gateway.post(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}/unassign-unit`, { unit_id: identity.callsign }, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyUnitAssigned(call, identity, false, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.MAKE_PRIMARY]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      await gateway.post(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}/primary-unit`, { unit_id: identity.callsign }, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyPrimaryUnit(call, identity, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      await gateway.patch(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}/assignment-times`, {
        unit_id: identity.callsign,
        assigned_at: input.assignedAt || undefined,
        dispatched_at: input.dispatchedAt || undefined,
        arrived_at: input.arrivedAt || undefined,
        ondt_at: input.ondtAt || undefined,
      }, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyAssignmentTimes(call, identity, input, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.CLEAR_UNIT]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      let callDetails = null;
      try { callDetails = await gateway.get(`/api/radio/call/${encodeURIComponent(input.callId)}`, { correlationId }); } catch { callDetails = null; }
      const activeUnits = extractActiveCallUnits(callDetails);
      const hasOtherActiveUnits = activeUnits.some((unit) => !unitMatches(unit, identity));
      const closesCall = !hasOtherActiveUnits;
      if (closesCall) {
        if (!input.disposition) {
          throw new DispatcherV3Error(V3_ERROR_CODES.DISPOSITION_REQUIRED, 'A disposition is required before closing the last unit\'s call', {
            statusCode: 409,
            details: { callId: input.callId, unitId: identity.unitId, callsign: identity.callsign },
          });
        }
        await gateway.post('/api/radio/dispose', { call_id: input.callId, disposition: input.disposition, unit_ids: [identity.callsign] }, { correlationId });
      } else {
        await gateway.post('/api/radio/clear', { call_id: input.callId, unit_id: identity.callsign, disposition: input.disposition || undefined }, { correlationId });
      }
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyUnitAssigned(call, identity, false, { correlationId, callId: input.callId });
      if (closesCall) verifyCallClosed(call, input.disposition, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.CLOSE_CALL]: async ({ input, correlationId }) => {
      await gateway.post('/api/radio/dispose', { call_id: input.callId, disposition: input.disposition, unit_ids: input.unitIds, note: input.note || undefined }, { correlationId });
      const call = await readCallForVerification(gateway, input.callId, correlationId);
      verifyCallClosed(call, input.disposition, { correlationId, callId: input.callId });
      return { success: true, verified: true, call };
    },

    [V3_ACTIONS.STATUS_CHECK]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      const response = await gateway.get('/api/radio/status-check', { correlationId });
      const units = Array.isArray(response?.units) ? response.units : [];
      const unit = units.find((candidate) => String(candidate?.unit_id || '').toUpperCase() === callsign.toUpperCase());
      if (!unit) throw new DispatcherV3Error(V3_ERROR_CODES.UNIT_NOT_FOUND, `Unit ${callsign} was not present in the selected dispatch center status catalog`, { statusCode: 404, details: { unitId: input.unitId, callsign } });
      return { unit, timestamp: response.timestamp || null };
    },

    [V3_ACTIONS.REQUEST_BACKUP]: async ({ input, runtimeContext, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      const alertResult = requireOperationalAlerts().requestBackup({ identity, runtimeContext, correlationId, callId: input.callId, location: input.location, reason: input.reason, priority: input.priority || 'urgent' });
      const note = await recordOperationalNote({ callId: input.callId, correlationId, note: `BACKUP REQUESTED by ${identity.callsign}${input.location ? ` at ${input.location}` : ''}${input.reason ? ` — ${input.reason}` : ''}` });
      return { ...alertResult, cadNote: note };
    },

    [V3_ACTIONS.DECLARE_EMERGENCY]: async ({ input }) => {
      throw new DispatcherV3Error(V3_ERROR_CODES.UNAUTHORIZED, 'Voice or planner actions cannot activate the emergency system; use the physical emergency button', {
        statusCode: 403,
        details: { unitId: input.unitId, callId: input.callId || null, source: 'dispatcher_v3_action' },
      });
    },
  };
}

function toCadCallMutation(input) {
  const map = {
    type: 'type', location: 'location', apt: 'apt', city: 'city', state: 'state', zip: 'zip', county: 'county', municipality: 'municipality',
    zone: 'zone', latitude: 'latitude', longitude: 'longitude', crossStreet1: 'cross_street_1', crossStreet2: 'cross_street_2', priority: 'priority',
    status: 'status', description: 'description', callerName: 'caller_name', callerPhone: 'callback_number', locationAddressId: 'location_address_id',
    securityClientId: 'security_client_id', securityClientSiteId: 'security_client_site_id', disposition: 'disposition', dispositionNotes: 'disposition_notes',
  };
  const body = {};
  for (const [source, target] of Object.entries(map)) if (input[source] !== null && input[source] !== undefined) body[target] = input[source];
  return body;
}

async function resolveLocationMutation(gateway, input, correlationId) {
  if (!input.location) return input;
  const query = [input.location, input.city].filter(Boolean).join(', ');
  const resolution = await gateway.get('/api/radio/locations/resolve', { correlationId, query: { q: query } });
  const location = resolution?.location || {};
  const address = clean(location.address);
  if (!address) {
    throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Unable to verify call location: ${query}`, {
      statusCode: 422,
      details: { query, source: resolution?.source || null },
    });
  }
  return {
    ...input,
    location: address,
    city: clean(location.city) || clean(location.municipality) || input.city,
    municipality: clean(location.municipality) || input.municipality,
    county: clean(location.county) || input.county,
    state: clean(location.state) || input.state,
    zip: clean(location.zipCode || location.zip) || input.zip,
    latitude: clean(location.latitude) || input.latitude,
    longitude: clean(location.longitude) || input.longitude,
    crossStreet1: clean(location.crossStreet1 || location.cross_street_1) || input.crossStreet1,
    crossStreet2: clean(location.crossStreet2 || location.cross_street_2) || input.crossStreet2,
  };
}

function extractActiveCallUnits(payload) {
  const root = payload?.call || payload?.data?.call || payload?.data || payload || {};
  const candidates = root.assignments || root.active_assignments || root.activeAssignments || root.assigned_units || root.assignedUnits || root.units;
  if (!Array.isArray(candidates)) return [];
  return candidates.filter((unit) => !unit || typeof unit !== 'object' ? Boolean(unit) : !(unit.unassigned_at || unit.unassignedAt || unit.cleared_at || unit.clearedAt || unit.active === false));
}

function unitMatches(candidate, identity) {
  if (candidate === undefined || candidate === null) return false;
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const value = normalizeIdentity(candidate);
    return value === normalizeIdentity(identity.unitId) || value === normalizeIdentity(identity.callsign);
  }
  const values = [candidate.unit_id, candidate.unitId, candidate.user_id, candidate.userId, candidate.id, candidate.unit_number, candidate.unitNumber, candidate.callsign].map(normalizeIdentity).filter(Boolean);
  return values.includes(normalizeIdentity(identity.unitId)) || values.includes(normalizeIdentity(identity.callsign));
}

function normalizeIdentity(value) { return value === undefined || value === null ? '' : String(value).trim().toUpperCase(); }
function clean(value) { if (value === undefined || value === null) return null; const text = String(value).trim(); return text || null; }
