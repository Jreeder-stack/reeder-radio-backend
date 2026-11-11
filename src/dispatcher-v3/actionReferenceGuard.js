// AI-DISP-V3-001 / 03-04. Revalidate a materialized candidate at the
// immediate write boundary. Never authorize a reference from an old
// model/context snapshot. This is NOT a replacement CAD permission check.
import { V3_ACTIONS } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { assertV3DeadlineActive } from './operationDeadline.js';

const CALL_MUTATIONS = new Set([
  V3_ACTIONS.UPDATE_CALL, V3_ACTIONS.ADD_CALL_NOTE, V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY,
  V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES, V3_ACTIONS.CLEAR_UNIT,
  V3_ACTIONS.CLOSE_CALL,
]);
const TERMINAL = new Set(['closed', 'cleared', 'cancelled', 'canceled', 'voided', 'disposed']);

export async function assertV3ActionReferencesFresh({
  plan, speakerCallsign, unitIdentityService, operationalContextService,
  correlationId, turnEnvelope,
} = {}) {
  assertV3DeadlineActive();
  if (!plan?.action) return true;
  const originalRef = plan.referenceProof || {};
  if (plan.input?.unitId && unitIdentityService) {
    const source = originalRef.unitRef || speakerCallsign;
    const fresh = await unitIdentityService.resolve(source, { correlationId });
    if (fresh.unitId !== plan.input.unitId) {
      throw new DispatcherV3Error(V3_ERROR_CODES.UNIT_AMBIGUOUS,
        'The unit target changed before the CAD write', { statusCode: 409 });
    }
  }
  if (CALL_MUTATIONS.has(plan.action) && plan.input?.callId) {
    const target = String(plan.input.callId);
    if (originalRef.implicit) {
      // If a call has changed while the model, resolution or another
      // operation was running, stop before writing to the wrong incident.
      const fresh = await operationalContextService.snapshot({ speakerCallsign, correlationId });
      const current = await operationalContextService.resolveCallId({
        callRef: originalRef.callRef, operationalContext: fresh,
        preferCurrentCall: originalRef.preferCurrentCall, correlationId,
      });
      if (current !== target) {
        throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
          'The incident reference changed before CAD submission', { statusCode: 409 });
      }
    }
    // An explicitly named old call remains available if it is still active
    // and center-authorized; current assignment alone does not override it.
    const response = await operationalContextService.gateway.get(
      '/api/radio/v3/cad/calls/' + encodeURIComponent(target), { correlationId });
    const call = response?.call;
    const found = String(call?.call_id || call?.id || call?.callId || '');
    if (!call || found !== target) throw new DispatcherV3Error(V3_ERROR_CODES.CALL_NOT_FOUND,
      'The requested call could not be confirmed in this dispatch center', { statusCode: 404 });
    const actualCenter = call.dispatch_center_id || call.dispatchCenterId || null;
    if (actualCenter && String(actualCenter) !== String(operationalContextService.gateway.context?.dispatchCenterId)) {
      throw new DispatcherV3Error(V3_ERROR_CODES.UNAUTHORIZED,
        'The requested call belongs to another dispatch center', { statusCode: 403 });
    }
    if (TERMINAL.has(String(call.status || '').trim().toLowerCase())) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CALL_RELATIONSHIP_CHANGED,
        'The requested call is no longer active', { statusCode: 409 });
    }
  }
  assertV3DeadlineActive();
  if (turnEnvelope?.speaker?.callsign && String(turnEnvelope.speaker.callsign) !== String(speakerCallsign)) {
    throw new DispatcherV3Error(V3_ERROR_CODES.UNAUTHORIZED,
      'The requested radio speaker no longer matches the trusted turn', { statusCode: 403 });
  }
  return true;
}
