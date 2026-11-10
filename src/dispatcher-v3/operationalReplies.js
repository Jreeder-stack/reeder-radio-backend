// AI-DISP-V3-001 04-04. Safe, actionable failure wording.
// Use only deterministic server-owned error codes, never CAD notes or model prose.
const clean = (v,n=40)=>String(v??'').trim().replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,n);
const ADDRESSEE = (v)=>clean(v,36)||'Unit';
const errorReply = Object.freeze({
  CALL_AMBIGUOUS: 'More than one call matches. Give the call number or location.',
  CALL_NOT_FOUND: 'No matching call was verified in this dispatch center. Give a call number or a clearer location.',
  UNIT_AMBIGUOUS: 'Multiple units match. Repeat the complete callsign.',
  UNIT_NOT_FOUND: 'That unit could not be verified in this dispatch center. Check the callsign.',
  UNAUTHORIZED: 'That action is not authorized for this unit. Contact a human dispatcher.',
  CAD_UNAVAILABLE: 'unable to process that request because CAD is not available. No new completion was confirmed. Contact a human dispatcher if urgent.',
  CAD_REJECTED: 'CAD rejected that request. The change was not confirmed. Check the details with a dispatcher.',
  OPERATION_TIMEOUT: 'That request exceeded the processing limit. Check CAD before repeating any possible write.',
  TURN_STALE: 'That request expired. Give Central a new complete request.',
  CALL_RELATIONSHIP_CHANGED: 'That call or assignment changed. Identify the current call before trying again.',
  ZONE_NOT_FOUND: 'That zone is not available in this dispatch center. State a supported zone.',
  INVALID_STATUS_TRANSITION: 'CAD rejected that status change. Confirm the unit status before retrying.',
  INVALID_ACTION: 'That operation is not supported by radio. Contact a dispatcher for another option.',
  INVALID_ACTION_INPUT: 'A required detail is missing or invalid. Give the complete request.',
  INTERNAL_ERROR: 'Dispatcher could not process that request. Contact a human dispatcher if urgent.',
});
export function composeV3FailureReply({speakerCallsign,error,submittedWrites=0,outcome=null}={}){
  const unit=ADDRESSEE(speakerCallsign);
  if(outcome==='unknown'||submittedWrites>0)
    return unit+', a CAD submission may have occurred but is not verified. Do not repeat it until a dispatcher reconciles the outcome.';
  return unit+', '+(errorReply[clean(error?.code,60)]||'Unable to verify that request. Repeat the details or contact a human dispatcher.');
}
export function v3OperatorFault({status,reason,turnId,at=Date.now()}={}){
  if(!['failed','expired','interrupted'].includes(status))return null;
  // This is safe to expose in the existing protected profile-status payload.
  const known=new Set(['outbound_overloaded','invalid_or_stale_output','floor_or_transmission_failed',
    'stale_before_transmission','runtime_stopped','superseded_by_newer_reply',
    'session_replaced','transmission_error']);
  return Object.freeze({code:'RADIO_REPLY_NOT_DELIVERED',status,
    reason:known.has(reason)?reason:'radio_delivery_failed',
    turnId:clean(turnId,80)||null,
    at:new Date(at).toISOString(),
    // Relay injection cannot certify human audibility.
    verifiedHumanAudible:false});
}
