// AI-DISP-V3-001 / 04-02. Bounded semantic answer selection; CAD owns every fact.
// A model may request fields, never provide their values or a claimed outcome.
import { V3_ACTIONS } from './actionContracts.js';

const CALL_FIELDS = Object.freeze([
  'summary', 'number', 'nature', 'location', 'status', 'priority', 'units', 'reports',
]);
export const V3_READ_ANSWER_FIELDS = Object.freeze({
  [V3_ACTIONS.GET_CALL]: CALL_FIELDS,
  [V3_ACTIONS.GET_CURRENT_CALL]: CALL_FIELDS,
  [V3_ACTIONS.SEARCH_CALLS]: Object.freeze(['summary', 'count']),
  [V3_ACTIONS.LIST_ACTIVE_CALLS]: Object.freeze(['summary', 'count']),
  [V3_ACTIONS.STATUS_CHECK]: Object.freeze(['summary', 'status']),
  [V3_ACTIONS.TIME_CHECK]: Object.freeze(['summary', 'time']),
  [V3_ACTIONS.RADIO_CHECK]: Object.freeze(['summary', 'signal']),
});

const MAX_RADIO_CHARS = 420;
const safe = (value, limit = 70) => String(value ?? '').trim()
  .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').slice(0, limit);
const first = (...values) => values.map(item => safe(item)).find(Boolean) || '';
const label = (speaker) => {
  const value = safe(speaker, 32);
  return value ? value + ', ' : '';
};
const callId = (item) => first(item?.call_id, item?.callId, item?.id);
const numberOf = (item) => first(item?.call_number, item?.callNumber, item?.number);

function assignedUnits(call, shared) {
  if (shared && Array.isArray(shared.participatingUnits)) {
    const names = shared.participatingUnits.slice(0, 4).map(item => safe(item, 32)).filter(Boolean);
    return names.length ? 'assigned units ' + names.join(', ') : 'no assigned units listed';
  }
  const assigned = call?.assigned_units ?? call?.assignedUnits ?? call?.assignments;
  if (!Array.isArray(assigned)) return 'assigned units not available in CAD';
  const names = assigned.filter(item => item && (typeof item !== 'object'
    || !(item.active === false || item.unassigned_at || item.unassignedAt
      || item.cleared_at || item.clearedAt)))
    .slice(0, 4).map(item => typeof item === 'object'
      ? first(item.callsign, item.unit_number, item.unitNumber, item.unit_id, item.unitId, item.id)
      : safe(item, 32)).filter(Boolean);
  return names.length ? 'assigned units ' + names.join(', ') : 'no assigned units listed';
}

function reportedDetails(shared) {
  if (!shared) return 'field reports require a verified current incident';
  const reports = shared.reports;
  if (!Array.isArray(reports) || !reports.length) return 'no field reports listed in CAD';
  const report = reports.at(-1);
  const description = safe(report?.text, 105);
  if (!description) return 'field report detail unavailable';
  const attribution = safe(report?.reportedBy, 32);
  return 'latest unverified report' + (attribution ? ' from ' + attribution : '')
    + ': "' + description + '"';
}

function capReadAnswer(prefix, parts) {
  let answer = prefix + parts.join('; ') + '.';
  if (answer.length <= MAX_RADIO_CHARS) return answer;
  // These are read-only statements. Shorten returned field values rather
  // than dropping an answer or trimming a CAD write/unknown-outcome warning.
  answer = prefix + parts.map(part => safe(part, 66)).join('; ') + '.';
  if (answer.length <= MAX_RADIO_CHARS) return answer;
  return answer.slice(0, MAX_RADIO_CHARS - 2).trimEnd() + '.';
}

// Null means use the unchanged factual summary for this read. An answerFocus
// is normalized by the semantic contract, is NOT a CAD input or authorization,
// and cannot supply any text to be spoken.
export function composeV3GroundedRead({
  plan, result, speakerCallsign = null, sharedIncident = null,
  now = new Date(), formatTime = () => 'time unavailable',
} = {}) {
  const allowed = V3_READ_ANSWER_FIELDS[plan?.action];
  const focus = plan?.answerFocus;
  if (!allowed || !Array.isArray(focus) || focus.length === 0
    || focus.some(value => !allowed.includes(value)) || focus.includes('summary')) return null;
  const prefix = label(speakerCallsign);
  const data = result?.data || {};
  if ([V3_ACTIONS.SEARCH_CALLS, V3_ACTIONS.LIST_ACTIVE_CALLS].includes(plan.action)) {
    const calls = Array.isArray(data.calls) ? data.calls : [];
    const type = plan.action === V3_ACTIONS.SEARCH_CALLS ? 'matching CAD' : 'active';
    return prefix + calls.length + ' ' + type + ' call' + (calls.length === 1 ? '' : 's') + '.';
  }
  if (plan.action === V3_ACTIONS.STATUS_CHECK) {
    const status = first(data.unit?.status, data.status).replace(/_/g, ' ');
    return prefix + (status ? 'unit status ' + status : 'unit status not available in CAD') + '.';
  }
  if (plan.action === V3_ACTIONS.TIME_CHECK) {
    return prefix + formatTime(data.timestamp || now) + '.';
  }
  if (plan.action === V3_ACTIONS.RADIO_CHECK) return prefix + 'loud and clear.';

  const call = data.call || data.assignment?.call || data.assignment || data;
  const id = callId(call);
  const verifiedShared = sharedIncident?.verifiedCadFacts === true
    && sharedIncident.provenance === 'fresh_center_authorized_cad'
    && id && sharedIncident.callId === id ? sharedIncident : null;
  const number = first(numberOf(call), verifiedShared?.callNumber, id);
  const facts = {
    number: number ? 'call ' + safe(number, 44) : 'call number not available in CAD',
    nature: first(call?.nature, call?.type, call?.call_type, verifiedShared?.nature)
      ? 'nature ' + first(call?.nature, call?.type, call?.call_type, verifiedShared?.nature)
      : 'call nature not available in CAD',
    location: first(call?.location, call?.address, verifiedShared?.location)
      ? 'at ' + first(call?.location, call?.address, verifiedShared?.location)
      : 'call location not available in CAD',
    status: first(call?.status, verifiedShared?.status)
      ? 'status ' + first(call?.status, verifiedShared?.status).replace(/_/g, ' ')
      : 'call status not available in CAD',
    priority: first(call?.priority, verifiedShared?.priority)
      ? 'priority ' + first(call?.priority, verifiedShared?.priority)
      : 'call priority not available in CAD',
    units: assignedUnits(call, verifiedShared),
    reports: reportedDetails(verifiedShared),
  };
  const chosen = focus.filter(key => key !== 'summary');
  const hasNumber = chosen.includes('number');
  const head = !hasNumber && number ? 'call ' + safe(number, 44) + ', ' : '';
  return capReadAnswer(prefix + head, chosen.map(key => facts[key]).filter(Boolean));
}
