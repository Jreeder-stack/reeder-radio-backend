// AI-DISP-V3-001 / 03-06. Read-only reconciliation after a submitted
// mutation whose HTTP response or independent verification was lost.
// Never resubmit a POST/PATCH and never infer a new call from a similar address.
import { V3_ACTIONS } from './actionContracts.js';
import {
  readCallForVerification, readUnitForVerification,
  verifyUnitStatus, verifyUnitZone, verifyCallMutation,
  verifyUnitAssigned, verifyPrimaryUnit, verifyAssignmentTimes,
  verifyCallClosed, verifyCallNote,
} from './cadMutationVerifier.js';

export async function reconcileV3SubmittedWrite({
  action, input, gateway, unitIdentityService, correlationId,
} = {}) {
  if (!gateway || !unitIdentityService || !input) return { verified: false };
  try {
    if ([V3_ACTIONS.SET_UNIT_STATUS, V3_ACTIONS.CHANGE_UNIT_ZONE].includes(action)) {
      const identity = await unitIdentityService.resolve(input.unitId, { correlationId });
      const unit = await readUnitForVerification(gateway, identity.callsign, correlationId);
      if (action === V3_ACTIONS.SET_UNIT_STATUS) verifyUnitStatus(unit, input.status);
      else verifyUnitZone(unit, input.zone);
      return { verified: true, data: { unit } };
    }

    // Lost CREATE_CALL response without a returned call ID has no unique
    // server receipt. Never locate by similar nature/address and assume it
    // was the created record, and never issue a blind retry.
    if (action === V3_ACTIONS.CREATE_CALL || !input.callId) {
      return { verified: false, observation: 'no_unique_write_receipt' };
    }

    const call = await readCallForVerification(gateway, input.callId, correlationId);
    if (action === V3_ACTIONS.UPDATE_CALL) verifyCallMutation(call, input);
    else if ([V3_ACTIONS.ASSIGN_UNIT, V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.CLEAR_UNIT].includes(action)) {
      const identity = await unitIdentityService.resolve(input.unitId, { correlationId });
      verifyUnitAssigned(call, identity, action === V3_ACTIONS.ASSIGN_UNIT);
      if (action === V3_ACTIONS.CLEAR_UNIT && input.disposition
        && ['closed', 'cleared', 'cancelled'].includes(String(call.status || '').toLowerCase())) {
        verifyCallClosed(call, input.disposition);
      }
    } else if (action === V3_ACTIONS.MAKE_PRIMARY) {
      const identity = await unitIdentityService.resolve(input.unitId, { correlationId });
      verifyPrimaryUnit(call, identity);
    } else if (action === V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES) {
      const identity = await unitIdentityService.resolve(input.unitId, { correlationId });
      verifyAssignmentTimes(call, identity, input);
    } else if (action === V3_ACTIONS.CLOSE_CALL) {
      verifyCallClosed(call, input.disposition);
    } else if (action === V3_ACTIONS.ADD_CALL_NOTE) {
      // Matching text is NOT a unique write receipt. Another officer may
      // already have submitted identical text. Observe it but remain unknown.
      try {
        verifyCallNote(call, input.note);
        return { verified: false, observation: 'matching_note_without_unique_receipt' };
      } catch {
        return { verified: false, observation: 'note_not_seen' };
      }
    } else return { verified: false, observation: 'unsupported_reconciliation' };
    return { verified: true, data: { call } };
  } catch {
    return { verified: false, observation: 'fresh_cad_readback_not_conclusive' };
  }
}
