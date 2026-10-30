import { V3_ACTIONS } from './actionContracts.js';
import { isV3TurnEnvelope } from './turnEnvelope.js';

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

const VERIFIED_MUTATION_ACTIONS = new Set([
  V3_ACTIONS.SET_UNIT_STATUS,
  V3_ACTIONS.CHANGE_UNIT_ZONE,
  V3_ACTIONS.CREATE_CALL,
  V3_ACTIONS.UPDATE_CALL,
  V3_ACTIONS.ADD_CALL_NOTE,
  V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.UNASSIGN_UNIT,
  V3_ACTIONS.MAKE_PRIMARY,
  V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES,
  V3_ACTIONS.CLEAR_UNIT,
  V3_ACTIONS.CLOSE_CALL,
]);

const SMALL_NUMBER_WORDS = Object.freeze([
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
]);

const TENS_WORDS = Object.freeze({ 20: 'twenty', 30: 'thirty', 40: 'forty', 50: 'fifty' });

export function composeV3Response({ plan, result, speakerCallsign, now = new Date(), turnEnvelope = null, sharedIncident = null } = {}) {
  if (isV3TurnEnvelope(turnEnvelope) && turnEnvelope.speaker) speakerCallsign = turnEnvelope.speaker.callsign;
  const unit = clean(speakerCallsign) || 'unit';
  if (plan?.action === 'NO_ACTION') return null;
  if (plan?.action === 'CLARIFY') return clean(plan.clarification) || `${unit}, repeat your last.`;
  if (plan?.action === 'MULTI_ACTION') return compoundV3Response(unit, result, now);

  if (!result?.success) {
    const code = result?.error?.code;
    if (code === 'UNIT_AMBIGUOUS') return `${unit}, I have more than one matching unit. Repeat the callsign.`;
    if (code === 'UNIT_NOT_FOUND') return `${unit}, I couldn't locate that unit in this dispatch center.`;
    if (code === 'CALL_AMBIGUOUS') return `${unit}, which call?`;
    if (code === 'UNAUTHORIZED') return `${unit}, unable. That action isn't authorized.`;
    if (code === 'CAD_UNAVAILABLE') return `${unit}, CAD is unavailable. Try again.`;
    if (code === 'CALL_NOT_FOUND') return `${unit}, I couldn't locate that call.`;
    if (code === 'DISPOSITION_REQUIRED') return `${unit}, what's your disposition?`;
    return `${unit}, unable to complete that request.`;
  }

  if (!mutationVerificationSatisfied(plan, result)) {
    return `${unit}, unable to verify that change in CAD.`;
  }

  if (plan?.action === V3_ACTIONS.REPORT_FIELD_INCIDENT || plan?.action === V3_ACTIONS.UPDATE_FIELD_INCIDENT) {
    return clean(result?.data?.radioResponse) || `${unit}, copy.`;
  }

  if (ROUTINE_ACK_ACTIONS.has(plan?.action)) {
    return `Ten-four, ${formatMilitaryTimeForSpeech(now)}.`;
  }

  const data = result.data || {};
  const returned = data.call || data.assignment || data;
  const returnedId = clean(returned?.call_id || returned?.callId || returned?.id);
  if (sharedIncident?.verifiedCadFacts && sharedIncident.callId === returnedId
    && [V3_ACTIONS.GET_CALL, V3_ACTIONS.GET_CURRENT_CALL].includes(plan.action)) {
    return sharedIncidentResponse(unit, sharedIncident);
  }
  switch (plan.action) {
    case V3_ACTIONS.RADIO_CHECK:
      return `${unit}, loud and clear.`;
    case V3_ACTIONS.TIME_CHECK:
      return `${unit}, ${formatMilitaryTimeForSpeech(data.timestamp || now)}.`;
    case V3_ACTIONS.GET_CURRENT_CALL:
      return currentCallResponse(unit, data);
    case V3_ACTIONS.LIST_ACTIVE_CALLS:
      return activeCallsResponse(unit, data);
    case V3_ACTIONS.STATUS_CHECK:
      return statusCheckResponse(unit, data);
    case V3_ACTIONS.DECLARE_EMERGENCY:
      return `${unit}, unable. The emergency system requires the physical emergency button.`;
    default:
      return `${unit}, copy.`;
  }
}

function mutationVerificationSatisfied(plan, result) {
  if (plan?.action === 'MULTI_ACTION') {
    const steps = Array.isArray(result?.data?.steps) ? result.data.steps : [];
    for (const step of steps) {
      if (!VERIFIED_MUTATION_ACTIONS.has(step?.action)) continue;
      if (step?.result?.data?.verified !== true) return false;
    }
    return true;
  }
  if (!VERIFIED_MUTATION_ACTIONS.has(plan?.action)) return true;
  return result?.data?.verified === true;
}


// Only verified CAD mutations are announced as completed. Each independent
// read speaks the data actually returned by CAD, including in partial plans.
// A submitted/unverified action is NEVER a success or permission to retry all.
function compoundV3Response(unit, result, now) {
  const steps = Array.isArray(result?.data?.steps) ? result.data.steps : [];
  if (!steps.length) return unit + ', unable to confirm the requested operations.';
  const parts = [];
  for (const step of steps.slice(0, 10)) {
    const call = step.result?.data?.call || step.result?.data?.assignment || null;
    const action = step.action;
    if (step.status === 'duplicate_skipped') {
      parts.push('duplicate ' + shortAction(action) + ' not repeated');
    } else if (step.status === 'verified') {
      if (action === V3_ACTIONS.CREATE_CALL) {
        const type = clean(call?.type || call?.nature) || 'requested';
        const location = clean(call?.location || call?.address);
        parts.push(type + ' call created' + (location ? ' at ' + location : ''));
      } else if (action === V3_ACTIONS.SET_UNIT_STATUS) {
        const status = clean(step.result?.data?.unit?.status);
        parts.push(status ? 'unit marked ' + statusForSpeech(status) : 'unit status verified');
      } else {
        parts.push(shortAction(action) + ' verified in CAD');
      }
    } else if (step.status === 'read_success') {
      const data = step.result?.data || {};
      let read = null;
      if ([V3_ACTIONS.GET_CALL, V3_ACTIONS.GET_CURRENT_CALL].includes(action)) {
        read = currentCallResponse('', data);
      } else if (action === V3_ACTIONS.LIST_ACTIVE_CALLS) {
        read = activeCallsResponse('', data);
      } else if (action === V3_ACTIONS.SEARCH_CALLS) {
        read = activeCallsResponse('', { calls: data.calls || [] });
      } else if (action === V3_ACTIONS.STATUS_CHECK) {
        read = statusCheckResponse('', data);
      } else if (action === V3_ACTIONS.TIME_CHECK) {
        read = formatMilitaryTimeForSpeech(data.timestamp || now);
      } else if (action === V3_ACTIONS.RADIO_CHECK) {
        read = 'radio check loud and clear';
      }
      parts.push(read ? read.replace(/^,\s*/, '') : shortAction(action) + ' returned data');
    } else if (step.status === 'skipped_dependency') {
      parts.push(shortAction(action) + ' not attempted because its prerequisite was not verified');
    } else if (step.status === 'unknown') {
      parts.push(shortAction(action) + ' submitted or attempted, but outcome unconfirmed in CAD');
    } else if (step.status === 'partial') {
      parts.push(shortAction(action) + ' only partially recorded');
    } else if (step.status === 'completed') {
      parts.push(shortAction(action) + ' processed; CAD persistence not independently confirmed');
    } else {
      parts.push(shortAction(action) + ' not completed');
    }
  }
  const suffix = result?.success ? '' : ' Completed changes were not reversed. Do not repeat the entire request.';
  return (unit + ', ' + parts.join('; ') + '.' + suffix).slice(0, 800);
}

function shortAction(value) {
  return String(value || 'operation').toLowerCase().replace(/_/g, ' ');
}

function sharedIncidentResponse(unit, shared) {
  const call = clean(shared.callNumber) || clean(shared.callId);
  const parts = [call ? 'call ' + call : 'your shared incident', clean(shared.nature),
    shared.location ? 'at ' + clean(shared.location) : null].filter(Boolean);
  const members = Array.isArray(shared.participatingUnits) ? shared.participatingUnits.slice(0, 5).map(clean).filter(Boolean) : [];
  const reports = Array.isArray(shared.reports) ? shared.reports.slice(-2) : [];
  const summary = parts.join(', ') + '.' + (members.length ? ' Assigned units: ' + members.join(', ') + '.' : '');
  const notes = reports.map(report => (clean(report.reportedBy) ? clean(report.reportedBy) + ' reported: ' : 'Unattributed CAD note: ')
    + clean(report.text).slice(0, 125) + ' (unverified report).').join(' ');
  return (unit + ', ' + summary + (notes ? ' ' + notes : '')).slice(0, 600);
}

function activeCallsResponse(unit, data) {
  const calls = Array.isArray(data?.calls) ? data.calls : [];
  if (calls.length === 0) return `${unit}, no active calls on the screen.`;
  const summaries = calls.slice(0, 5).map((call) => {
    const number = callNumber(call);
    const nature = clean(call?.nature || call?.type || call?.call_type) || 'unknown nature';
    const location = clean(call?.location || call?.address);
    return `${number ? `call ${number}, ` : ''}${nature}${location ? ` at ${location}` : ''}`;
  });
  const remaining = calls.length - summaries.length;
  return `${unit}, ${calls.length} active call${calls.length === 1 ? '' : 's'}: ${summaries.join('; ')}${remaining > 0 ? `; plus ${remaining} more` : ''}.`;
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
