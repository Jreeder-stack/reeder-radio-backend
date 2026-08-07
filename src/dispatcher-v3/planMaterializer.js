import { V3_ACTIONS } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const SINGLE_UNIT_ACTIONS = new Set([
  V3_ACTIONS.SET_UNIT_STATUS,
  V3_ACTIONS.CHANGE_UNIT_ZONE,
  V3_ACTIONS.GET_CURRENT_CALL,
  V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.CLEAR_UNIT,
  V3_ACTIONS.STATUS_CHECK,
  V3_ACTIONS.REQUEST_BACKUP,
  V3_ACTIONS.DECLARE_EMERGENCY,
]);

const CONTEXTUAL_CALL_ACTIONS = new Set([
  V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.CLEAR_UNIT,
  V3_ACTIONS.ADD_CALL_NOTE,
]);

export async function materializeV3Plan(plan, {
  speakerCallsign,
  unitIdentityService,
  operationalContextService = null,
  operationalContext = null,
  correlationId,
} = {}) {
  if (!plan || typeof plan !== 'object') throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Planner result is required');
  if (plan.action === 'NO_ACTION' || plan.action === 'CLARIFY') return plan;
  if (!unitIdentityService) throw new TypeError('unitIdentityService is required');

  const input = { ...(plan.input || {}) };
  if (SINGLE_UNIT_ACTIONS.has(plan.action)) {
    const identity = await unitIdentityService.resolve(input.unitRef || speakerCallsign, { correlationId });
    input.unitId = identity.unitId;
    delete input.unitRef;
  }

  if (CONTEXTUAL_CALL_ACTIONS.has(plan.action) && !input.callId) {
    if (!operationalContextService) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Operational context service is required to resolve an implicit call');
    }
    input.callId = await operationalContextService.resolveCallId({
      callRef: input.callRef || null,
      operationalContext,
      correlationId,
    });
    delete input.callRef;
  }

  if (plan.action === V3_ACTIONS.CREATE_CALL) {
    const refs = normalizeRefs(input.unitRefs, speakerCallsign);
    input.unitIds = await resolveRefs(refs, unitIdentityService, correlationId);
    delete input.unitRefs;
  }

  if (plan.action === V3_ACTIONS.CLOSE_CALL && input.unitRefs !== undefined) {
    input.unitIds = await resolveRefs(normalizeRefs(input.unitRefs), unitIdentityService, correlationId);
    delete input.unitRefs;
  }

  if (plan.action === V3_ACTIONS.ADD_CALL_NOTE && input.unitRef) {
    const identity = await unitIdentityService.resolve(input.unitRef, { correlationId });
    input.unitId = identity.unitId;
    delete input.unitRef;
  }

  if ((plan.action === V3_ACTIONS.RADIO_CHECK || plan.action === V3_ACTIONS.TIME_CHECK) && input.unitRef) {
    const identity = await unitIdentityService.resolve(input.unitRef, { correlationId });
    input.unitId = identity.unitId;
    delete input.unitRef;
  }

  delete input.callRef;
  return Object.freeze({ ...plan, input: Object.freeze(input) });
}

async function resolveRefs(refs, service, correlationId) {
  const ids = [];
  for (const ref of refs) {
    const identity = await service.resolve(ref, { correlationId });
    if (!ids.includes(identity.unitId)) ids.push(identity.unitId);
  }
  return ids;
}

function normalizeRefs(value, fallback = null) {
  const refs = Array.isArray(value) ? value : value ? [value] : fallback ? [fallback] : [];
  return refs.map((ref) => String(ref).trim()).filter(Boolean);
}
