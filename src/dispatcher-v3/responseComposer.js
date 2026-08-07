import { V3_ACTIONS } from './actionContracts.js';

export function composeV3Response({ plan, result, speakerCallsign } = {}) {
  const unit = clean(speakerCallsign) || 'unit';
  if (plan?.action === 'NO_ACTION') return null;
  if (plan?.action === 'CLARIFY') return clean(plan.clarification) || `${unit}, repeat your last.`;

  if (!result?.success) {
    const code = result?.error?.code;
    if (code === 'UNIT_AMBIGUOUS') return `${unit}, I have more than one matching unit. Repeat the callsign.`;
    if (code === 'UNIT_NOT_FOUND') return `${unit}, I couldn't locate that unit in this dispatch center.`;
    if (code === 'UNAUTHORIZED') return `${unit}, unable. That action isn't authorized.`;
    if (code === 'CAD_UNAVAILABLE') return `${unit}, CAD is unavailable. Try again.`;
    if (code === 'CALL_NOT_FOUND') return `${unit}, I couldn't locate that call.`;
    return `${unit}, unable to complete that request.`;
  }

  const data = result.data || {};
  switch (plan.action) {
    case V3_ACTIONS.RADIO_CHECK:
      return `${unit}, loud and clear.`;
    case V3_ACTIONS.TIME_CHECK:
      return `${unit}, ${formatTime(data.timestamp)}.`;
    case V3_ACTIONS.SET_UNIT_STATUS:
      return `${unit}, showing ${statusForSpeech(plan.input?.status)}.`;
    case V3_ACTIONS.GET_CURRENT_CALL:
      return currentCallResponse(unit, data);
    case V3_ACTIONS.CREATE_CALL:
      return `${unit}, call created${callNumber(data) ? `, ${callNumber(data)}` : ''}.`;
    case V3_ACTIONS.ADD_CALL_NOTE:
      return `${unit}, note added.`;
    case V3_ACTIONS.ASSIGN_UNIT:
      return `${unit}, assignment updated.`;
    case V3_ACTIONS.CLEAR_UNIT:
      return `${unit}, clear.`;
    case V3_ACTIONS.CLOSE_CALL:
      return `${unit}, call closed.`;
    case V3_ACTIONS.STATUS_CHECK:
      return statusCheckResponse(unit, data);
    case V3_ACTIONS.REQUEST_BACKUP:
      return `${unit}, backup request sent.`;
    case V3_ACTIONS.DECLARE_EMERGENCY:
      return `${unit}, emergency activated.`;
    default:
      return `${unit}, copy.`;
  }
}

function currentCallResponse(unit, data) {
  const call = data?.call || data?.assignment || data;
  const number = callNumber(call);
  const nature = clean(call?.nature || call?.type || call?.call_type);
  const location = clean(call?.location || call?.address);
  if (!number && !nature && !location) return `${unit}, no current call found.`;
  return `${unit}, ${number ? `call ${number}` : 'your current call'}${nature ? `, ${nature}` : ''}${location ? ` at ${location}` : ''}.`;
}

function statusCheckResponse(unit, data) {
  const status = clean(data?.unit?.status || data?.status);
  return status ? `${unit}, status is ${statusForSpeech(status)}.` : `${unit}, status received.`;
}

function callNumber(data) {
  return clean(data?.call_number || data?.callNumber || data?.call?.call_number || data?.call?.callNumber || data?.id);
}

function statusForSpeech(value) {
  return clean(value)?.replace(/_/g, ' ') || 'updated';
}

function formatTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return 'time unavailable';
  return new Intl.DateTimeFormat('en-US', { timeZone: process.env.TZ || 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
