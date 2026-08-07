import { V3_ACTIONS } from './actionContracts.js';

const ROUTINE_ACK_ACTIONS = new Set([
  V3_ACTIONS.SET_UNIT_STATUS,
  V3_ACTIONS.CHANGE_UNIT_ZONE,
  V3_ACTIONS.CREATE_CALL,
  V3_ACTIONS.ADD_CALL_NOTE,
  V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.CLEAR_UNIT,
  V3_ACTIONS.CLOSE_CALL,
  V3_ACTIONS.REQUEST_BACKUP,
]);

const SMALL_NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
]);

const TENS_WORDS = Object.freeze({ 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty' });

export function composeV3Response({ plan, result, speakerCallsign, now = new Date() } = {}) {
  const unit = clean(speakerCallsign) || 'unit';
  if (plan?.action === 'NO_ACTION') return null;
  if (plan?.action === 'CLARIFY') return clean(plan.clarification) || `${unit}, repeat your last.`;

  if (!result?.success) {
    const code = result?.error?.code;
    if (code === 'UNIT_AMBIGUOUS') return `${unit}, I have more than one matching unit. Repeat the callsign.`;
    if (code === 'UNIT_NOT_FOUND') return `${unit}, I couldn't locate that unit in this dispatch center.`;
    if (code === 'CALL_AMBIGUOUS') return `${unit}, which call?`;
    if (code === 'UNAUTHORIZED') return `${unit}, unable. That action isn't authorized.`;
    if (code === 'CAD_UNAVAILABLE') return `${unit}, CAD is unavailable. Try again.`;
    if (code === 'CALL_NOT_FOUND') return `${unit}, I couldn't locate that call.`;
    return `${unit}, unable to complete that request.`;
  }

  if (plan?.action === 'MULTI_ACTION' || ROUTINE_ACK_ACTIONS.has(plan?.action)) {
    return `Ten-four, ${formatMilitaryTimeForSpeech(now)}.`;
  }

  const data = result.data || {};
  switch (plan.action) {
    case V3_ACTIONS.RADIO_CHECK:
      return `${unit}, loud and clear.`;
    case V3_ACTIONS.TIME_CHECK:
      return `${unit}, ${formatMilitaryTimeForSpeech(data.timestamp || now)}.`;
    case V3_ACTIONS.GET_CURRENT_CALL:
      return currentCallResponse(unit, data);
    case V3_ACTIONS.STATUS_CHECK:
      return statusCheckResponse(unit, data);
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

export function formatMilitaryTimeForSpeech(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'time unavailable';

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: process.env.TZ || 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return 'time unavailable';

  if (minute === 0) {
    if (hour === 0) return 'zero hundred hours';
    return `${militaryHourWords(hour)} hundred hours`;
  }
  return `${militaryHourWords(hour)} ${militaryMinuteWords(minute)} hours`;
}

function militaryHourWords(hour) {
  if (hour < 10) return `zero ${SMALL_NUMBER_WORDS[hour]}`;
  return numberWordsUnderSixty(hour);
}

function militaryMinuteWords(minute) {
  if (minute < 10) return `zero ${SMALL_NUMBER_WORDS[minute]}`;
  return numberWordsUnderSixty(minute);
}

function numberWordsUnderSixty(value) {
  if (value < 20) return SMALL_NUMBER_WORDS[value];
  const tens = Math.floor(value / 10) * 10;
  const ones = value % 10;
  return ones ? `${TENS_WORDS[tens]}-${SMALL_NUMBER_WORDS[ones]}` : TENS_WORDS[tens];
}

function clean(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text || null;
}
