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
const START_CALL_RX = /^(?:start|create|open)\s+(?:me\s+)?(?:a|an|the)?\s*(.+?)\s+(?:at|on)\s+(.+?)\s*[?.!]*$/i;
const SELF_INITIATED_RESPONSE_RX = /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:en\s*route|responding)\s+to\s+(?:a|an|the)?\s*(.+?)\s+(?:at|on)\s+(.+?)\s*[?.!]*$/i;
const NO_ASSIGN_SUFFIX_RX = /(?:,\s*)?(?:don't|do\s+not)\s+(?:assign|attach|put)\s+(?:anybody|anyone|any\s+unit|me)(?:\s+to\s+(?:it|the\s+call))?\s*[?.!]*$/i;
const DISPOSITION_RX = /^(?:arrest(?:\s+made)?|report(?:\s+taken)?|citation(?:\s+issued)?|warning(?:\s+issued)?|unfounded|gone\s+on\s+arrival|goa|unable\s+to\s+locate|utl|no\s+action(?:\s+taken)?|false\s+alarm|referred|handled\s+by\s+(?:another|other)\s+agency|cancel+l?ed\s+by\s+(?:the\s+)?complainant)\s*[.!]*$/i;

const NUMBER_WORDS = Object.freeze({
  zero: '0', oh: '0', one: '1', won: '1', two: '2', too: '2', three: '3', four: '4', for: '4',
  five: '5', six: '6', seven: '7', eight: '8', ate: '8', nine: '9', ten: '10', eleven: '11',
  twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17',
  eighteen: '18', nineteen: '19', twenty: '20',
});

const STATUS_PATTERNS = Object.freeze([
  ['en_route_secondary', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:en\s*route\s+(?:to\s+)?secondary|responding\s+(?:to\s+)?secondary)\s*[?.!]*$/i],
  ['arrived_secondary', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:arrived\s+(?:at\s+)?secondary|on\s+scene\s+(?:at\s+)?secondary)\s*[?.!]*$/i],
  ['out_of_vehicle', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:out\s+of\s+(?:the\s+)?vehicle|out\s+of\s+car)\s*[?.!]*$/i],
  ['out_of_service', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:out\s+of\s+service|oos)\s*[?.!]*$/i],
  ['not_available', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:not\s+available|unavailable)\s*[?.!]*$/i],
  ['on_scene', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:on\s+scene|on\s+location|arrived|arriving|i(?:'m|\s+am)\s+(?:there|on\s+scene)|10[-\s/]?97|ten\s+ninety[-\s]?seven)\s*[?.!]*$/i],
  ['en_route', /^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:en\s*route|responding)(?:\s+to\s+(?:the\s+)?(?:call(?:\s+on\s+my\s+screen)?|current\s+call|my\s+current\s+call))?\s*[?.!]*$/i],
  ['en_route', /^(?:go\s+)?(?:me\s+)?en\s*route\s+to\s+(?:the\s+)?(?:call(?:\s+on\s+my\s+screen)?|current\s+call|my\s+current\s+call)\s*[?.!]*$/i],
  ['available', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:available|clear\s+and\s+available|back\s+in\s+service|10[-\s/]?8|ten\s+eight)\s*[?.!]*$/i],
  ['on_duty', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:on\s+duty|in\s+service)\s*[?.!]*$/i],
  ['off_duty', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:off\s+duty|end\s+of\s+tour)\s*[?.!]*$/i],
  ['busy', /^(?:show|mark|put|set)?\s*(?:me\s+)?busy\s*[?.!]*$/i],
  ['training', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:training|in\s+training)\s*[?.!]*$/i],
  ['court', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:court|in\s+court)\s*[?.!]*$/i],
  ['detail', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:detail|on\s+detail)\s*[?.!]*$/i],
  ['special_duty', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:special\s+duty|on\s+special\s+duty)\s*[?.!]*$/i],
  ['on_call', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:on\s+call)\s*[?.!]*$/i],
]);

const NAMED_UNIT_STATUS_PATTERNS = Object.freeze([
  ['out_of_service', /\b(?:out\s+of\s+service|oos)\b/i],
  ['off_duty', /\b(?:off\s+duty|end\s+of\s+tour)\b/i],
  ['on_duty', /\b(?:on\s+duty|in\s+service)\b/i],
  ['on_scene', /\b(?:on\s+scene|on\s+location|arrived)\b/i],
  ['en_route', /\b(?:en\s+route|responding)\b/i],
  ['available', /\b(?:available|back\s+in\s+service)\b/i],
  ['busy', /\bbusy\b/i],
  ['training', /\b(?:training|in\s+training)\b/i],
  ['court', /\b(?:court|in\s+court)\b/i],
  ['detail', /\b(?:detail|on\s+detail)\b/i],
  ['special_duty', /\b(?:special\s+duty|on\s+special\s+duty)\b/i],
]);

export function planDeterministicV3Intent({ transcript, speakerCallsign, operationalContext = null, pendingContext = null } = {}) {
  const text = stripSpeakerPrefix(normalize(transcript), speakerCallsign);
  if (!text) return null;

  if (RADIO_CHECK_RX.test(text)) return plan(V3_ACTIONS.RADIO_CHECK, {}, 'deterministic_radio_check');
  if (TIME_CHECK_RX.test(text)) return plan(V3_ACTIONS.TIME_CHECK, {}, 'deterministic_time_check');
  if (CURRENT_CALL_RX.test(text)) return plan(V3_ACTIONS.GET_CURRENT_CALL, { unitRef: speakerCallsign }, 'deterministic_current_call');
  if (ACTIVE_CALLS_RX.test(text)) return plan(V3_ACTIONS.LIST_ACTIVE_CALLS, {}, 'deterministic_list_active_calls');
  if (STATUS_CHECK_RX.test(text)) return plan(V3_ACTIONS.STATUS_CHECK, { unitRef: speakerCallsign }, 'deterministic_status_check');
  if (BACKUP_RX.test(text)) return plan(V3_ACTIONS.REQUEST_BACKUP, { unitRef: speakerCallsign, reason: text, priority: 'urgent' }, 'deterministic_backup');
  if (CLEAR_CALL_RX.test(text)) return plan(V3_ACTIONS.CLEAR_UNIT, { unitRef: speakerCallsign }, 'deterministic_clear_current_call');
  if (MAKE_PRIMARY_SELF_RX.test(text)) return plan(V3_ACTIONS.MAKE_PRIMARY, { unitRef: speakerCallsign }, 'deterministic_make_primary_self');

  const selfInitiatedResponse = planSelfInitiatedResponse(text, speakerCallsign);
  if (selfInitiatedResponse) return selfInitiatedResponse;

  const startedCall = planStartedCall(text, speakerCallsign);
  if (startedCall) return startedCall;

  const fieldIncident = planFieldIncident(text, speakerCallsign);
  if (fieldIncident) return fieldIncident;

  const namedCallResponse = planNamedCallResponse(text, speakerCallsign, operationalContext);
  if (namedCallResponse) return namedCallResponse;

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

function planSelfInitiatedResponse(text, speakerCallsign) {
  const match = text.match(SELF_INITIATED_RESPONSE_RX);
  if (!match) return null;

  const type = String(match[1] || '').trim();
  const location = String(match[2] || '').trim();
  if (!type || !location || !speakerCallsign) return null;

  return Object.freeze({
    action: 'MULTI_ACTION',
    actions: Object.freeze([
      Object.freeze({
        action: V3_ACTIONS.CREATE_CALL,
        input: Object.freeze({
          type: type.toUpperCase(),
          location,
          unitRefs: [speakerCallsign],
        }),
      }),
      Object.freeze({
        action: V3_ACTIONS.SET_UNIT_STATUS,
        input: Object.freeze({ unitRef: speakerCallsign, status: 'en_route' }),
      }),
    ]),
    input: Object.freeze({}),
    confidence: 1,
    clarification: null,
    reason: 'deterministic_self_initiated_response',
  });
}

function planStartedCall(text, speakerCallsign) {
  const noAssign = NO_ASSIGN_SUFFIX_RX.test(text);
  const command = text.replace(NO_ASSIGN_SUFFIX_RX, '').trim().replace(/,+$/, '').trim();
  const match = command.match(START_CALL_RX);
  if (!match) return null;

  const type = String(match[1] || '').trim();
  const location = String(match[2] || '').trim();
  if (!type || !location) return null;

  const input = {
    type: type.toUpperCase(),
    location,
  };
  if (!noAssign && speakerCallsign) input.unitRefs = [speakerCallsign];
  return plan(V3_ACTIONS.CREATE_CALL, input, 'deterministic_start_call');
}

function planFieldIncident(text, speakerCallsign) {
  const patterns = [
    ['shots_fired', /\bshots?\s+fired\b|\btaking\s+fire\b|\bunder\s+fire\b/i],
    ['officer_assist', /\bofficer\s+down\b|\b10[-\s/]?33\b|\bten\s+thirty[-\s]?three\b|\bemergency\s+traffic\b|\bsignal\s+100\b/i],
    ['officer_assist', /\b(?:i\s+have|i(?:'ve|\s+have)\s+got|we\s+have|got)\s+(?:one|a\s+subject|him|her|them)\s+(?:running|fleeing)\b/i],
    ['gunpoint', /\b(?:gun\s*point|gunpoint)\b/i],
    ['taserpoint', /\b(?:taser\s*point|taserpoint)\b/i],
    ['fight', /\b(?:fighting|struggling)\s+with\b|\bphysical\s+fight\b/i],
  ];
  const match = patterns.find(([, rx]) => rx.test(text));
  if (!match) return null;
  return plan(V3_ACTIONS.REPORT_FIELD_INCIDENT, {
    unitRef: speakerCallsign,
    eventType: match[0],
    note: text,
  }, `deterministic_field_incident_${match[0]}`);
}

function planNamedCallResponse(text, speakerCallsign, operationalContext) {
  const match = text.match(/^(?:(?:show|mark|put|set)\s+)?(?:me\s+)?(?:en\s*route|responding)\s+to\s+(?:the\s+)?(.+?)\s*[?.!]*$/i);
  const callRef = match?.[1]?.trim();
  if (!callRef || /^(?:call|current\s+call|my\s+(?:current\s+)?call|call\s+on\s+my\s+screen)$/i.test(callRef)) return null;
  if (callMatchesReference(operationalContext?.currentCall, callRef)) {
    return plan(V3_ACTIONS.SET_UNIT_STATUS, { unitRef: speakerCallsign, status: 'en_route' }, 'deterministic_named_call_status');
  }
  return Object.freeze({
    action: 'MULTI_ACTION',
    actions: Object.freeze([
      Object.freeze({ action: V3_ACTIONS.ASSIGN_UNIT, input: Object.freeze({ callRef, unitRef: speakerCallsign }) }),
      Object.freeze({ action: V3_ACTIONS.SET_UNIT_STATUS, input: Object.freeze({ unitRef: speakerCallsign, status: 'en_route' }) }),
    ]),
    input: Object.freeze({}),
    confidence: 1,
    clarification: null,
    reason: 'deterministic_named_call_response',
  });
}

function callMatchesReference(call, callRef) {
  if (!call || !callRef) return false;
  const reference = normalize(callRef).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const fields = [call.type, call.nature, call.call_type, call.location, call.address, call.call_number, call.callNumber]
    .map((value) => normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean);
  return Boolean(reference && fields.some((field) => field.includes(reference) || reference.includes(field)));
}

function planNamedUnitStatus(text, speakerCallsign, operationalContext) {
  const units = Array.isArray(operationalContext?.units) ? operationalContext.units : [];
  if (units.length === 0) return null;

  const command = canonicalTokens(text);
  const speaker = canonicalTokens(speakerCallsign);
  const mentioned = units
    .map((unit) => String(unit?.callsign || unit?.unit_id || '').trim())
    .filter(Boolean)
    .filter((callsign) => {
      const canonical = canonicalTokens(callsign);
      return canonical && canonical !== speaker && containsTokenSequence(command, canonical);
    });

  if (mentioned.length !== 1) return null;
  for (const [status, rx] of NAMED_UNIT_STATUS_PATTERNS) {
    if (rx.test(text)) {
      return plan(V3_ACTIONS.SET_UNIT_STATUS, { unitRef: mentioned[0], status }, `deterministic_named_unit_status_${status}`);
    }
  }
  return null;
}

function containsTokenSequence(haystack, needle) {
  return (` ${haystack} `).includes(` ${needle} `);
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

function stripSpeakerPrefix(text, speakerCallsign) {
  const command = canonicalTokens(text);
  const speaker = canonicalTokens(speakerCallsign);
  if (!command || !speaker) return text;
  if (command === speaker) return '';
  if (command.startsWith(`${speaker} `)) return command.slice(speaker.length).trim();
  return text;
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
  return String(value || '').trim().replace(/\s+/g, ' ');
}
