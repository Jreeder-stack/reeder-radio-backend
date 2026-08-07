import { V3_ACTIONS } from './actionContracts.js';

const TIMESTAMPED_ACTIONS = new Set([
  V3_ACTIONS.SET_UNIT_STATUS,
  V3_ACTIONS.GET_CURRENT_CALL,
  V3_ACTIONS.CREATE_CALL,
  V3_ACTIONS.ADD_CALL_NOTE,
  V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.CLEAR_UNIT,
  V3_ACTIONS.CLOSE_CALL,
  V3_ACTIONS.STATUS_CHECK,
  V3_ACTIONS.REQUEST_BACKUP,
]);

export function composeV3Response({ plan, result, speakerCallsign, now = new Date() } = {}) {
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
  let response;
  switch (plan.action) {
    case V3_ACTIONS.RADIO_CHECK:
      response = `${unit}, loud and clear.`;
      break;
    case V3_ACTIONS.TIME_CHECK:
      response = `${unit}, ${formatMilitaryTime(data.timestamp || now)}.`;
      break;
    case V3_ACTIONS.SET_UNIT_STATUS:
      response = `${unit}, showing ${statusForSpeech(plan.input?.status)}.`;
      break;
    case V3_ACTIONS.GET_CURRENT_CALL:
      response = currentCallResponse(unit, data);
      break;
    case V3_ACTIONS.CREATE_CALL:
      response = `${unit}, call created${callNumber(data) ? `, ${callNumber(data)}` : ''}.`;
      break;
    case V3_ACTIONS.ADD_CALL_NOTE:
      response = `${unit}, note added.`;
      break;
    case V3_ACTIONS.ASSIGN_UNIT:
      response = `${unit}, assignment updated.`;
      break;
    case V3_ACTIONS.CLEAR_UNIT:
      response = `${unit}, clear.`;
      break;
    case V3_ACTIONS.CLOSE_CALL:
      response = `${unit}, call closed.`;
      break;
    case V3_ACTIONS.STATUS_CHECK:
      response = statusCheckResponse(unit, data);
      break;
    case V3_ACTIONS.REQUEST_BACKUP:
      response = `${unit}, backup request sent.`;
      break;
    case V3_ACTIONS.DECLARE_EMERGENCY:
      response = `${unit}, emergency activated.`;
      break;
    default:
      response = `${unit}, copy.`;
      break;
  }

  return TIMESTAMPED_ACTIONS.has(plan.action) ? appendMilitaryTime(response, now) : response;
}

function appendMilitaryTime(value, now) {
  const text = clean(value);
  if (!text) return text;
  const withoutPeriod = text.replace(/\.+$/, '');
  return `${withoutPeriod}, ${formatMilitaryTime(now)}.`;
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

function formatMilitaryTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'time unavailable';
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ || 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
  return `${formatted.replace(':', '')} hours`;
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
