import { V3_ACTIONS } from './actionContracts.js';

const RADIO_CHECK_RX = /^(?:can\s+you\s+)?(?:give\s+me\s+(?:a\s+)?)?(?:radio\s+check|how\s+do\s+you\s+(?:copy|read)(?:\s+me)?|do\s+you\s+copy(?:\s+me)?|copy\s+me)\s*[?.!]*$/i;
const TIME_CHECK_RX = /^(?:time\s+check|what(?:'s|\s+is)\s+the\s+time|what\s+time\s+is\s+it|give\s+me\s+the\s+time|current\s+time)\s*[?.!]*$/i;
const CURRENT_CALL_RX = /^(?:what(?:'s|\s+is)\s+(?:my|our)\s+(?:current\s+)?call|what\s+call\s+am\s+i\s+on|give\s+me\s+(?:my|our)\s+(?:current\s+)?call|current\s+call)\s*[?.!]*$/i;
const STATUS_CHECK_RX = /^(?:what(?:'s|\s+is)\s+my\s+status|what\s+status\s+do\s+you\s+have\s+me|status\s+check|check\s+my\s+status)\s*[?.!]*$/i;
const BACKUP_RX = /^(?:send\s+(?:me\s+)?backup|send\s+(?:me\s+)?another\s+unit|i\s+need\s+backup|need\s+backup|i\s+need\s+another\s+unit|need\s+another\s+unit|requesting\s+backup|start\s+(?:me\s+)?backup)\s*[?.!]*$/i;

const STATUS_PATTERNS = Object.freeze([
  ['en_route_secondary', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:en\s+route\s+(?:to\s+)?secondary|responding\s+(?:to\s+)?secondary)\s*[?.!]*$/i],
  ['arrived_secondary', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:arrived\s+(?:at\s+)?secondary|on\s+scene\s+(?:at\s+)?secondary)\s*[?.!]*$/i],
  ['out_of_vehicle', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:out\s+of\s+(?:the\s+)?vehicle|out\s+of\s+car)\s*[?.!]*$/i],
  ['out_of_service', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:out\s+of\s+service|oos)\s*[?.!]*$/i],
  ['not_available', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:not\s+available|unavailable)\s*[?.!]*$/i],
  ['on_scene', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:on\s+scene|on\s+location|arrived|10[-\s/]?97|ten\s+ninety[-\s]?seven)\s*[?.!]*$/i],
  ['en_route', /^(?:show|mark|put|set)?\s*(?:me\s+)?(?:en\s+route|responding|10[-\s/]?76|ten\s+seventy[-\s]?six)\s*[?.!]*$/i],
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

export function planDeterministicV3Intent({ transcript, speakerCallsign } = {}) {
  const text = normalize(transcript);
  if (!text) return null;

  if (RADIO_CHECK_RX.test(text)) return plan(V3_ACTIONS.RADIO_CHECK, {}, 'deterministic_radio_check');
  if (TIME_CHECK_RX.test(text)) return plan(V3_ACTIONS.TIME_CHECK, {}, 'deterministic_time_check');
  if (CURRENT_CALL_RX.test(text)) return plan(V3_ACTIONS.GET_CURRENT_CALL, { unitRef: speakerCallsign }, 'deterministic_current_call');
  if (STATUS_CHECK_RX.test(text)) return plan(V3_ACTIONS.STATUS_CHECK, { unitRef: speakerCallsign }, 'deterministic_status_check');
  if (BACKUP_RX.test(text)) return plan(V3_ACTIONS.REQUEST_BACKUP, { unitRef: speakerCallsign, reason: text, priority: 'urgent' }, 'deterministic_backup');

  for (const [status, rx] of STATUS_PATTERNS) {
    if (rx.test(text)) return plan(V3_ACTIONS.SET_UNIT_STATUS, { unitRef: speakerCallsign, status }, `deterministic_status_${status}`);
  }

  return null;
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

function normalize(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}
