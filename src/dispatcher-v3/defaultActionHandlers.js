import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { V3_ACTIONS } from './actionContracts.js';
import { createResolvedCallHandler } from './createCallHandler.js';

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
      return { recorded: true, skipped: false };
    } catch (error) {
      return { recorded: false, skipped: false, error: { code: error?.code || V3_ERROR_CODES.CAD_REJECTED, message: error?.message || 'Failed to record operational alert note' } };
    }
  };

  const createCall = createResolvedCallHandler({ gateway, resolveSafeCallsign });

  return {
    [V3_ACTIONS.RADIO_CHECK]: async ({ input }) => ({ unitId: input.unitId || null, acknowledged: true }),
    [V3_ACTIONS.TIME_CHECK]: async ({ input }) => ({ unitId: input.unitId || null, timestamp: now().toISOString() }),

    [V3_ACTIONS.SET_UNIT_STATUS]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      const result = await gateway.post('/api/radio/status', { unit_id: callsign, status: input.status, note: input.note || undefined }, { correlationId });
      const returnedStatus = normalizeStatus(result?.status || result?.current_status || result?.currentStatus);
      const requestedStatus = normalizeStatus(input.status);
      if (!returnedStatus || returnedStatus !== requestedStatus) {
        throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Command Link did not confirm ${callsign} changed to ${requestedStatus}`, {
          statusCode: 502, retryable: false, details: { correlationId, callsign, requestedStatus, returnedStatus, response: result || null },
        });
      }
      return result;
    },

    [V3_ACTIONS.CHANGE_UNIT_ZONE]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.post('/api/radio/zone', { unit_id: callsign, zone: input.zone }, { correlationId });
    },

    [V3_ACTIONS.GET_CURRENT_CALL]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.get(`/api/radio/unit/${encodeURIComponent(callsign)}/call`, { correlationId });
    },

    [V3_ACTIONS.GET_CALL]: async ({ input, correlationId }) =>
      gateway.get(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}`, { correlationId }),

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
      const body = toCadCallMutation(input);
      return gateway.patch(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}`, body, { correlationId });
    },

    [V3_ACTIONS.ADD_CALL_NOTE]: async ({ input, correlationId }) => gateway.post('/api/radio/note', {
      call_id: input.callId, note: input.note, unit_id: input.unitId || undefined,
    }, { correlationId }),

    [V3_ACTIONS.ASSIGN_UNIT]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.post('/api/radio/assign', { call_id: input.callId, unit_id: callsign }, { correlationId });
    },

    [V3_ACTIONS.UNASSIGN_UNIT]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.post(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}/unassign-unit`, { unit_id: callsign }, { correlationId });
    },

    [V3_ACTIONS.MAKE_PRIMARY]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.post(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}/primary-unit`, { unit_id: callsign }, { correlationId });
    },

    [V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.patch(`${CAD_PARITY_PREFIX}/calls/${encodeURIComponent(input.callId)}/assignment-times`, {
        unit_id: callsign,
        assigned_at: input.assignedAt || undefined,
        dispatched_at: input.dispatchedAt || undefined,
        arrived_at: input.arrivedAt || undefined,
        ondt_at: input.ondtAt || undefined,
      }, { correlationId });
    },

    [V3_ACTIONS.CLEAR_UNIT]: async ({ input, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      let callDetails = null;
      try { callDetails = await gateway.get(`/api/radio/call/${encodeURIComponent(input.callId)}`, { correlationId }); } catch { callDetails = null; }
      const activeUnits = extractActiveCallUnits(callDetails);
      const isOnlyActiveUnit = activeUnits.length === 1 && activeUnits.some((unit) => unitMatches(unit, identity));
      if (isOnlyActiveUnit) {
        return gateway.post('/api/radio/dispose', { call_id: input.callId, disposition: input.disposition || 'CLEARED', unit_ids: [identity.callsign] }, { correlationId });
      }
      return gateway.post('/api/radio/clear', { call_id: input.callId, unit_id: identity.callsign, disposition: input.disposition || undefined }, { correlationId });
    },

    [V3_ACTIONS.CLOSE_CALL]: async ({ input, correlationId }) => gateway.post('/api/radio/dispose', {
      call_id: input.callId, disposition: input.disposition, unit_ids: input.unitIds, note: input.note || undefined,
    }, { correlationId }),

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

    [V3_ACTIONS.DECLARE_EMERGENCY]: async ({ input, runtimeContext, correlationId }) => {
      const identity = await resolveSafeIdentity(input.unitId, correlationId);
      const emergencyResult = requireOperationalAlerts().declareEmergency({ identity, runtimeContext, correlationId, callId: input.callId, location: input.location, reason: input.reason });
      const note = await recordOperationalNote({ callId: input.callId, correlationId, note: `EMERGENCY ACTIVATED by ${identity.callsign}${input.location ? ` at ${input.location}` : ''}${input.reason ? ` — ${input.reason}` : ''}` });
      return { ...emergencyResult, cadNote: note };
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
function normalizeStatus(value) { return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); }
