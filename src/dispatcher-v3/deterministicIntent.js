import { V3_ACTIONS } from './actionContracts.js';

const RADIO_CHECK_RX = /^(?:can\s+you\s+)?(?:give\s+me\s+(?:a\s+)?)?(?:radio\s+check|how\s+do\s+you\s+(?:copy|read)(?:\s+me)?|do\s+you\s+copy(?:\s+me)?|copy\s+me)\s*[?.!]*$/i;
const TIME_CHECK_RX = /^(?:time\s+check|what(?:'s|\s+is)\s+the\s+time|what\s+time\s+is\s+it|give\s+me\s+the\s+time|current\s+time)\s*[?.!]*$/i;
const CURRENT_CALL_RX = /^(?:what(?:'s|\s+is)\s+(?:my|our)\s+(?:current\s+)?call|what\s+call\s+am\s+i\s+on|give\s+me\s+(?:my|our)\s+(?:current\s+)?call|current\s+call)\s*[?.!]*$/i;
const ACTIVE_CALLS_RX = /^(?:(?:what|which)\s+calls?\s+(?:are|is)\s+(?:on|showing\s+on)\s+(?:the|my)\s+screen|(?:what|which)\s+(?:active|open|holding)\s+calls?\s+(?:are\s+there|do\s+(?:we|you)\s+have)|(?:list|read|give|show)\s+(?:me\s+)?(?:the\s+)?(?:active|open|holding)?\s*calls?)\s*[?.!]*$/i;
const STATUS_CHECK_RX = /^(?:what(?:'s|\s+is)\s+my\s+status|what\s+status\s+do\s+you\s+have\s+me|status\s+check|check\s+my\s+status)\s*[?.!]*$/i;
const BACKUP_RX = /^(?:send\s+(?:me\s+)?backup|send\s+(?:me\s+)?another\s+unit|i\s+need\s+backup|need\s+backup|i\s+need\s+another\s+unit|need\s+another\s+unit|requesting\s+backup|start\s+(?:me\s+)?backup)\s*[?.!]*$/i;
const ZONE_CHANGE_RX = /^(?:(?:change|switch|move|put)\s+(?:me\s+)?(?:to|on)?\s*zone\s+[a-z0-9-]+|(?:change|switch|move)\s+zone\s+(?:to\s+)?[a-z0-9-]+)\s*[?.!]*$/i;
const CLEAR_CALL_RX = /^(?:(?:i(?:'m|\s+am)\s+)?clear(?:\s+of|\s+from)?\s+(?:(?:the|my|that)\s+)?call(?:\s+i\s+was\s+on)?|clear\s+me(?:\s+of|\s+from)?\s+(?:(?:the|my|that)\s+)?call|show\s+me\s+clear(?:\s+of|\s+from)?\s+(?:(?:the|my|that)\s+)?call)\s*[?.!]*$/i;
const MAKE_PRIMARY_SELF_RX = /^(?:(?:make|show|mark|put|set)\s+me\s+(?:as\s+)?(?:the\s+)?primary(?:\s+unit)?|(?:make|show|mark|put|set)\s+(?:this|my)\s+unit\s+(?:as\s+)?(?:the\s+)?primary|i(?:'m|\s+am)\s+(?:the\s+)?primary(?:\s+unit)?|primary\s+me)\s*(?:on\s+(?:the|my|this|that)\s+(?:current\s+)?call)?\s*[?.!]*$/i;
const DISPOSITION_RX = /^(?:arrest(?:\s+made)?|report(?:\s+taken)?|citation(?:\s+issued)?|warning(?:\s+issued)?|unfounded|gone\s+on\s+arrival|goa|unable\s+to\s+locate|utl|no\s+action(?:\s+taken)?|false\s+alarm|referred|handled\s+by\s+(?:another|other)\s+agency|cancel+l?ed\s+by\s+(?:the\s+)?complainant)\s*[.!]*$/i;

const NUMBER_WORDS = Object.freeze({
  zero: '0', oh: '0', one: '1', won: '1', two: '2', too: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9', ten: '10', eleven: '11',
  twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20',
});

const STATUS_PATTERNS = Object.freeze([
  ['en_route_secondary', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:en\s*route\s+(?:to\s+)?secondary|responding\s+(?:to\s+)?secondary)\s*[?.!]*$/i],
  ['arrived_secondary', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:arrived\s+(?:at\s+)?secondary|on\s+scene\s+(?:at\s+)?secondary)\s*[?.!]*$/i],
  ['out_of_vehicle', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:out\s+of\s+(?:the\s+)?vehicle|out\s+of\s+car)\s*[?.!]*$/i],
  ['out_of_service', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:out\s+of\s+service|oos)\s*[?.!]*$/i],
  ['not_available', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:not\s+available|unavailable)\s*[?.!]*$/i],
  ['on_scene', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:on\s+scene|on\s+location|arrived|arriving|i(?:'m|\s+am)\s+(?:there|on\s+scene)|10[-\s/]?97|ten\s+ninety[-\s]?seven)\s*[?.!]*$/i],
  ['en_route', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:en\s*route|responding)(?:\s+to\s+(?:the\s+)?(?:call(?:\s+on\s+my\s+screen)?|current\s+call|my\s+current\s+call))?\s*[?.!]*$/i],
  ['en_route', /^(?:go\s+)?(?:me\s+)?en\s*route\s+to\s+(?:the\s+)?(?:call(?:\s+on\s+my\s+screen)?|current\s+call|my\s+current\s+call)\s*[?.!]*$/i],
  ['available', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:available|clear\s+and\s+available|back\s+in\s+service|10[-\s/]?8|ten\s+eight)\s*[?.!]*$/i],
  ['on_duty', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:on\s+duty|in\s+service)\s*[?.!]*$/i],
  ['off_duty', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:off\s+duty|end\s+of\s+tour)\s*[?.!]*$/i],
  ['busy', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?busy\s*[?.!]*$/i],
  ['training', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:training|in\s+training)\s*[?.!]*$/i],
  ['court', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:court|in\s+court)\s*[?.!]*$/i],
  ['detail', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:detail|on\s+detail)\s*[?.!]*$/i],
  ['special_duty', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:special\s+duty|on\s+special\s+duty)\s*[?.!]*$/i],
  ['on_call', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:on\s+call)\s*[?.!]*$/i],
]);

// A named target is followed by a COMPLETE status complement, never a keyword
// found elsewhere in the transmission (or inside the target's callsign).
const NAMED_UNIT_STATUS_PATTERNS = Object.freeze([
  ['en_route_secondary', /^(?:en\s*route\s+(?:to\s+)?secondary|responding\s+(?:to\s+)?secondary)$/i],
  ['arrived_secondary', /^(?:arrived\s+(?:at\s+)?secondary|on\s+scene\s+(?:at\s+)?secondary)$/i],
  ['out_of_vehicle', /^(?:out\s+of\s+(?:the\s+)?vehicle|out\s+of\s+car)$/i],
  ['out_of_service', /^(?:out\s+of\s+service|oos)$/i],
  ['not_available', /^(?:not\s+available|unavailable)$/i],
  ['off_duty', /^(?:off\s+duty|end\s+of\s+tour)$/i],
  ['on_duty', /^(?:on\s+duty|in\s+service)$/i],
  ['on_scene', /^(?:on\s+scene|on\s+location|arrived|arriving|10[-\s/]?97|ten\s+ninety[-\s]?seven)$/i],
  ['en_route', /^(?:en\s*route|responding)$/i],
  ['available', /^(?:available|clear\s+and\s+available|back\s+in\s+service|10[-\s/]?8|ten\s+eight)$/i],
  ['busy', /^busy$/i],
  ['training', /^(?:training|in\s+training)$/i],
  ['court', /^(?:court|in\s+court)$/i],
  ['detail', /^(?:detail|on\s+detail)$/i],
  ['special_duty', /^(?:special\s+duty|on\s+special\s+duty)$/i],
  ['on_call', /^on\s+call$/i],
]);

// These are complete urgent reports. Free-form reports, locations, quotations,
// questions and conditions belong to semantic interpretation, not keyword hits.
const FIELD_INCIDENT_PATTERNS = Object.freeze([
  ['shots_fired', /^(?:shots?\s+fired|(?:(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+)?(?:taking\s+fire|under\s+fire))$/i],
  ['officer_assist', /^(?:officer\s+down|(?:10[-\s/]?33|ten\s+thirty[-\s]?three)(?:\s+emergency\s+traffic)?|emergency\s+traffic|signal\s+100)$/i],
  ['officer_assist', /^(?:i\s+have|i(?:'ve|\s+have)\s+got|we\s+have|got)\s+(?:one|a\s+subject|him|her|them)\s+(?:running|fleeing)$/i],
  ['gunpoint', /^(?:i\s+have|we\s+have)\s+(?:one|a\s+subject|him|her|them)\s+at\s+gun\s*point$/i],
  ['taserpoint', /^(?:i\s+have|we\s+have)\s+(?:one|a\s+subject|him|her|them)\s+at\s+taser\s*point$/i],
  ['fight', /^(?:i(?:'m|\s+am)|we(?:'re|\s+are))\s+(?:fighting|struggling)\s+with\s+(?:him|her|them|a\s+subject)$/i],
]);

export function planDeterministicV3Intent({ transcript, speakerCallsign, operationalContext = null, pendingContext = null } = {}) {
  const text = normalizeV3CommandText({ transcript, speakerCallsign });
  if (!text) return null;

  if (RADIO_CHECK_RX.test(text)) return plan(V3_ACTIONS.RADIO_CHECK, {}, 'deterministic_radio_check');
  if (TIME_CHECK_RX.test(text)) return plan(V3_ACTIONS.TIME_CHECK, {}, 'deterministic_time_check');
  if (CURRENT_CALL_RX.test(text)) return plan(V3_ACTIONS.GET_CURRENT_CALL, { unitRef: speakerCallsign }, 'deterministic_current_call');
  if (ACTIVE_CALLS_RX.test(text)) return plan(V3_ACTIONS.LIST_ACTIVE_CALLS, {}, 'deterministic_list_active_calls');
  if (STATUS_CHECK_RX.test(text)) return plan(V3_ACTIONS.STATUS_CHECK, { unitRef: speakerCallsign }, 'deterministic_status_check');

  // An interrogative ending can change even a short status report's meaning.
  // Returning null delegates the intact sentence to the existing planner.
  if (text.includes('?')) return null;
  if (BACKUP_RX.test(text)) return plan(V3_ACTIONS.REQUEST_BACKUP, { unitRef: speakerCallsign, reason: text, priority: 'urgent' }, 'deterministic_backup');
  if (CLEAR_CALL_RX.test(text)) return plan(V3_ACTIONS.CLEAR_UNIT, { unitRef: speakerCallsign }, 'deterministic_clear_current_call');
  if (MAKE_PRIMARY_SELF_RX.test(text)) return plan(V3_ACTIONS.MAKE_PRIMARY, { unitRef: speakerCallsign }, 'deterministic_make_primary_self');

  const fieldIncident = planFieldIncident(text, speakerCallsign);
  if (fieldIncident) return fieldIncident;

  const namedUnitStatus = planNamedUnitStatus(text, speakerCallsign, operationalContext);
  if (namedUnitStatus) return namedUnitStatus;

  if (ZONE_CHANGE_RX.test(text)) {
    const zone = extractZone(text);
    if (zone) return plan(V3_ACTIONS.CHANGE_UNIT_ZONE, { unitRef: speakerCallsign, zone }, 'deterministic_zone_change');
  }

  for (const [status, rx] of STATUS_PATTERNS) {
    if (rx.test(text)) return plan(V3_ACTIONS.SET_UNIT_STATUS, { unitRef: speakerCallsign, status }, `deterministic_status_${status}`);
  }

  if (pendingContext?.kind === 'disposition' && pendingContext.callId && DISPOSITION_RX.test(text)) {
    return plan(V3_ACTIONS.CLEAR_UNIT, {
      callId: pendingContext.callId,
      unitRef: speakerCallsign,
      disposition: text.replace(/[.!]+$/, '').trim().toUpperCase(),
    }, 'deterministic_pending_disposition');
  }

  return null;
}

function planFieldIncident(text, speakerCallsign) {
  const statement = text.replace(/[.!]+$/, '').trim();
  const match = FIELD_INCIDENT_PATTERNS.find(([, rx]) => rx.test(statement));
  if (!match) return null;
  return plan(V3_ACTIONS.REPORT_FIELD_INCIDENT, {
    unitRef: speakerCallsign,
    eventType: match[0],
    note: text,
  }, `deterministic_field_incident_${match[0]}`);
}

function planNamedUnitStatus(text, speakerCallsign, operationalContext) {
  const units = Array.isArray(operationalContext?.units) ? operationalContext.units : [];
  const command = text.match(/^(?:show|mark|put|set)\s+(.+?)\s*[.!]*$/i)?.[1];
  if (!command || !units.length) return null;

  const matches = units.flatMap((unit) => {
    const callsign = String(unit?.callsign || unit?.unit_id || '').trim();
    const remainder = afterCallsignPrefix(command, callsign);
    if (remainder === null) return [];
    const statusText = remainder.replace(/^as\s+/i, '').trim();
    const status = NAMED_UNIT_STATUS_PATTERNS.find(([, rx]) => rx.test(statusText))?.[0];
    return status ? [{ callsign, status }] : [];
  });

  // Even duplicate roster entries are insufficient target evidence. Let the
  // semantic/resolution path clarify rather than choosing the first record.
  if (matches.length !== 1) return null;
  const { callsign, status } = matches[0];
  return plan(V3_ACTIONS.SET_UNIT_STATUS, { unitRef: callsign, status }, `deterministic_named_unit_status_${status}`);
}

function extractZone(text) {
  const match = String(text || '').match(/\bzone\s+(?:to\s+)?([a-z0-9-]+)\b/i);
  if (!match?.[1]) return null;
  const raw = match[1].trim();
  return /^\d+$/.test(raw) ? `ZONE ${raw}` : raw.toUpperCase();
}

function plan(action, input, reason) {
  return Object.freeze({
    action,
    input: Object.freeze({ ...input }),
    confidence: 1,
    clarification: null,
    reason,
  });
}

export function normalizeV3CommandText({ transcript, speakerCallsign } = {}) {
  const text = normalize(transcript);
  return afterCallsignPrefix(text, speakerCallsign) ?? text;
}

function afterCallsignPrefix(text, callsign) {
  const target = canonicalTokens(callsign).split(' ').filter(Boolean);
  if (!target.length) return null;
  const tokens = [...text.matchAll(/[a-z0-9]+/gi)];
  if (tokens.length < target.length || tokens[0].index !== 0) return null;
  let end = 0;
  for (let index = 0; index < target.length; index += 1) {
    const token = tokens[index];
    // Only callsign separators may occur inside the matched identity. Never
    // remove quotation marks or sentence boundaries to manufacture a command.
    if (!/^[\s_\-/]*$/.test(text.slice(end, token.index))) return null;
    if (canonicalTokens(token[0]) !== target[index]) return null;
    end = token.index + token[0].length;
  }
  const rest = text.slice(end);
  if (!rest) return '';
  if (!/^(?:\s|,|:)/.test(rest)) return null;
  return rest.replace(/^[\s,:]+/, '');
}

function canonicalTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[,.:'’;/_\-]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => NUMBER_WORDS[token] || token)
    .join(' ')
    .trim();
}

function normalize(value) {
  return String(value || '')
    .trim()
    .replace(/\bin\s+route\b/gi, 'en route')
    .replace(/\s+/g, ' ');
}
