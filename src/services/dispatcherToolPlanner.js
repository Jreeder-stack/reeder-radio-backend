import {
  getDispatcherTool,
  validateDispatcherToolArguments,
} from './dispatcherToolRegistry.js';

const DEFAULT_MIN_CONFIDENCE = 0.70;

const SAFETY_CRITICAL_RX = /\b(officer\s+down|shots?\s+fired|gun\s*point|weapon|armed|10[-\s/]?33|ten\s+thirty[-\s]?three|foot\s+pursuit|vehicle\s+pursuit|in\s+pursuit|hostage|fight\s+in\s+progress|need\s+ems|request\s+ems|send\s+ems|need\s+fire|request\s+fire|send\s+fire|signal\s+100)\b/i;

const EXISTING_INTENT_TOOL_MAP = new Map([
  ['RADIO_CHECK', 'radio_check'],
  ['TIME_CHECK', 'time_check'],
  ['STATUS_CHANGE', 'update_unit_status'],
  ['STATUS_CHANGE_OTHER', 'update_unit_status'],
  ['CREATE_CALL', 'create_call'],
  ['CREATE_CALL_PROMPT', 'create_call'],
  ['ASSIGN_CALL', 'assign_unit_to_call'],
  ['ASSIGN_OTHER_UNIT', 'assign_unit_to_call'],
  ['ADD_NOTE', 'add_call_note'],
  ['LOG_EVENT_NOTE', 'add_call_note'],
  ['RUN_PLATE', 'run_plate'],
  ['PERSON_CHECK_DETAILS', 'run_person'],
  ['PERSON_CHECK_DL', 'run_person'],
  ['PERSON_CHECK_SSN', 'run_person'],
  ['QUERY_CALLS', 'query_pending_calls'],
  ['MY_CALL', 'get_unit_assignment'],
  ['CALL_DETAILS', 'get_call_details'],
  ['CLEAR_UNIT', 'clear_unit'],
  ['DISPOSE_CALL', 'close_call'],
  ['CANCEL_CALL', 'cancel_call'],
  ['REQUEST_BACKUP', 'request_backup'],
]);

function shortText(value, maxLength = 240) {
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, maxLength) : null;
}

export function isToolPlannerConfigured() {
  return false;
}

export function isToolPlannerShadowEnabled() {
  return false;
}

export function containsSafetyCriticalTraffic(transcript) {
  return SAFETY_CRITICAL_RX.test(String(transcript || ''));
}

export function mapExistingIntentToTool(existingResult) {
  const intent = String(existingResult?.intent || '').trim().toUpperCase();
  return EXISTING_INTENT_TOOL_MAP.get(intent) || null;
}

export function compareShadowPlan(existingResult, shadowPlan) {
  const existingTool = mapExistingIntentToTool(existingResult);
  const proposedTool = shadowPlan?.tool || null;
  let outcome = 'unmapped';
  if (!existingTool && !proposedTool) outcome = 'both_no_action';
  else if (!existingTool && proposedTool) outcome = 'planner_only';
  else if (existingTool && !proposedTool) outcome = 'existing_only';
  else if (existingTool === proposedTool) outcome = 'agreement';
  else outcome = 'disagreement';
  return { existingTool, proposedTool, outcome };
}

export function validateShadowToolPlan(candidate, { unitId, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;

  const rawTool = candidate.tool === null ? null : String(candidate.tool || '').trim();
  const confidence = Number(candidate.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  if (!rawTool) {
    return {
      tool: null,
      arguments: {},
      confidence,
      missingFields: [],
      needsClarification: false,
      clarificationQuestion: null,
      reason: shortText(candidate.reason),
      executable: false,
      shadowOnly: true,
    };
  }

  const tool = getDispatcherTool(rawTool);
  if (!tool || confidence < minConfidence) return null;

  const suppliedArgs = candidate.arguments && typeof candidate.arguments === 'object'
    ? { ...candidate.arguments }
    : {};

  if (
    unitId
    && ['update_unit_status', 'get_unit_assignment', 'clear_unit', 'request_backup'].includes(rawTool)
    && !suppliedArgs.unitId
  ) {
    suppliedArgs.unitId = unitId;
  }

  const validation = validateDispatcherToolArguments(rawTool, suppliedArgs, candidate.missingFields);
  const needsClarification = candidate.needsClarification === true || validation.missingFields.length > 0;
  const clarificationQuestion = shortText(candidate.clarificationQuestion);

  if (needsClarification && !clarificationQuestion) return null;
  if (!needsClarification && !validation.valid) return null;

  return {
    tool: rawTool,
    arguments: validation.arguments,
    confidence,
    missingFields: validation.missingFields,
    needsClarification,
    clarificationQuestion,
    reason: shortText(candidate.reason),
    executable: false,
    shadowOnly: true,
    risk: tool.risk,
    confirmationRequired: tool.confirmationRequired,
  };
}

export async function planDispatcherToolShadow(context) {
  return {
    unitId: context?.unitId || null,
    state: context?.currentState || null,
    transcript: String(context?.transcript || '').slice(0, 600),
    existingIntent: context?.existingResult?.intent || null,
    executed: false,
    mode: 'shadow',
    status: 'disabled_hotfix',
    latencyMs: 0,
  };
}

export function scheduleDispatcherToolShadow() {
  return false;
}
