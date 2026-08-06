import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { V3_ACTIONS } from './actionContracts.js';

export function createDefaultV3ActionHandlers({ gateway, unitIdentityService, now = () => new Date() } = {}) {
  if (!gateway) throw new TypeError('gateway is required');
  if (!unitIdentityService) throw new TypeError('unitIdentityService is required');

  const resolveSafeCallsign = async (unitId, correlationId) => {
    const byId = await unitIdentityService.resolve(unitId, { correlationId });
    const byCallsign = await unitIdentityService.resolve(byId.callsign, { correlationId });
    if (byCallsign.unitId !== byId.unitId) {
      throw new DispatcherV3Error(
        V3_ERROR_CODES.UNIT_AMBIGUOUS,
        `Unit callsign ${byId.callsign} is not uniquely safe for execution`,
        { statusCode: 409, details: { unitId: byId.unitId, callsign: byId.callsign } },
      );
    }
    return byId.callsign;
  };

  return {
    [V3_ACTIONS.RADIO_CHECK]: async ({ input }) => ({ unitId: input.unitId || null, acknowledged: true }),
    [V3_ACTIONS.TIME_CHECK]: async ({ input }) => ({ unitId: input.unitId || null, timestamp: now().toISOString() }),

    [V3_ACTIONS.SET_UNIT_STATUS]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.request('/api/radio/status', {
        method: 'POST', correlationId,
        body: { unit_id: callsign, status: input.status, note: input.note || undefined },
      });
    },

    [V3_ACTIONS.GET_CURRENT_CALL]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.request(`/api/radio/unit/${encodeURIComponent(callsign)}/call`, { correlationId });
    },

    [V3_ACTIONS.CREATE_CALL]: async ({ input, correlationId }) => {
      const callsigns = [];
      for (const unitId of input.unitIds) callsigns.push(await resolveSafeCallsign(unitId, correlationId));
      return gateway.request('/api/radio/call', {
        method: 'POST', correlationId,
        body: {
          type: input.type,
          location: input.location,
          city: input.city || undefined,
          municipality: input.municipality || undefined,
          priority: input.priority || undefined,
          description: input.description || undefined,
          caller_name: input.callerName || undefined,
          caller_phone: input.callerPhone || undefined,
          zone: input.zone || undefined,
          units: callsigns,
        },
      });
    },

    [V3_ACTIONS.ADD_CALL_NOTE]: async ({ input, correlationId }) => gateway.request('/api/radio/note', {
      method: 'POST', correlationId,
      body: { call_id: input.callId, note: input.note, unit_id: input.unitId || undefined },
    }),

    [V3_ACTIONS.ASSIGN_UNIT]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.request('/api/radio/assign', {
        method: 'POST', correlationId,
        body: { call_id: input.callId, unit_id: callsign },
      });
    },

    [V3_ACTIONS.CLEAR_UNIT]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.request('/api/radio/clear', {
        method: 'POST', correlationId,
        body: { call_id: input.callId, unit_id: callsign, disposition: input.disposition || undefined },
      });
    },

    [V3_ACTIONS.CLOSE_CALL]: async ({ input, correlationId }) => gateway.request('/api/radio/dispose', {
      method: 'POST', correlationId,
      body: { call_id: input.callId, disposition: input.disposition, unit_ids: input.unitIds, note: input.note || undefined },
    }),

    [V3_ACTIONS.STATUS_CHECK]: async ({ input, correlationId }) => {
      const callsign = await resolveSafeCallsign(input.unitId, correlationId);
      return gateway.request(`/api/radio/status-check?unit_id=${encodeURIComponent(callsign)}`, { correlationId });
    },

    [V3_ACTIONS.REQUEST_BACKUP]: unsupported('REQUEST_BACKUP'),
    [V3_ACTIONS.DECLARE_EMERGENCY]: unsupported('DECLARE_EMERGENCY'),
  };
}

function unsupported(action) {
  return async () => {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.INVALID_ACTION,
      `${action} requires a dedicated Command Link/Command Comms integration handler before it can execute`,
      { statusCode: 501, details: { action, implemented: false } },
    );
  };
}
