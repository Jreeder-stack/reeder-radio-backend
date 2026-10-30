// AI-DISP-V3-001 / 03-02. One interpretation contract for both the
// deterministic shortcut and the existing Azure OpenAI semantic planner.
// This module classifies intent; it NEVER authorizes a CAD action.
import { V3_ACTIONS, getV3ActionDefinition, listV3Actions } from './actionContracts.js';
import { hasV3Scope } from './runtimeContract.js';
import { sanitizeV3OperationalContext } from './operationalContext.js';
import { normalizeV3PendingTaskProposal, pendingV3TaskForModel } from './clarificationTasks.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

export const V3_INTENT_TYPES = Object.freeze([
  'action_request', 'question', 'observation', 'correction', 'cancellation',
  'clarification', 'conversation_only', 'unaddressed',
]);

const TYPES = new Set(V3_INTENT_TYPES);
const CONTROLS = new Set(['NO_ACTION', 'CLARIFY', 'CANCEL_TASK', 'NEW_TOPIC', 'RESUME_TASK', 'CORRECT_TASK']);
const READ_ACTIONS = new Set([
  V3_ACTIONS.RADIO_CHECK, V3_ACTIONS.TIME_CHECK, V3_ACTIONS.STATUS_CHECK,
  V3_ACTIONS.GET_CURRENT_CALL, V3_ACTIONS.GET_CALL,
  V3_ACTIONS.LIST_ACTIVE_CALLS, V3_ACTIONS.SEARCH_CALLS,
]);
const REPORT_ACTIONS = new Set([
  V3_ACTIONS.ADD_CALL_NOTE, V3_ACTIONS.REPORT_FIELD_INCIDENT,
  V3_ACTIONS.UPDATE_FIELD_INCIDENT,
]);
const MAX_PLAN_ACTIONS = 10;
const CALL_TARGET_ACTIONS = new Set([
  V3_ACTIONS.GET_CALL, V3_ACTIONS.UPDATE_CALL, V3_ACTIONS.ADD_CALL_NOTE,
  V3_ACTIONS.ASSIGN_UNIT, V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY,
  V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES, V3_ACTIONS.CLEAR_UNIT, V3_ACTIONS.CLOSE_CALL,
]);
const MAX_INPUT_FIELDS = 36;
const MAX_INPUT_CHARS = 1500;
const MAX_INPUT_ITEMS = 24;
const RESERVED_MODEL_FIELDS = new Set([
  'unitId', 'unitIds', 'accountId', 'connectionId', 'speakerUnitId',
  'dispatchCenterId', 'runtimeGeneration', 'profileId', 'runtimeId',
  'verified', 'authorized', 'permissionGrants', 'scopes', 'beforeCadWrite',
]);
// Physical emergency is not a voice capability, even when the caller has
// unit.write permission. The existing hardware entry point is unchanged.
const VOICE_ACTIONS = new Set(listV3Actions().filter(action => action !== V3_ACTIONS.DECLARE_EMERGENCY));

function invalid(message, reason = 'invalid_semantic_contract') {
  return new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, message, {
    statusCode: 400, details: { reason },
  });
}

function bounded(value, max) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function plain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeValue(value, field) {
  if (typeof value === 'string') {
    if (value.length > MAX_INPUT_CHARS) throw invalid('Semantic input is too long', 'oversized_input');
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > MAX_INPUT_ITEMS) throw invalid('Too many semantic input values', 'oversized_input');
    return Object.freeze(value.map(item => {
      if (typeof item !== 'string' || item.length > MAX_INPUT_CHARS) {
        throw invalid('Unsupported array value in semantic input', 'invalid_input_shape');
      }
      return item.trim();
    }));
  }
  throw invalid('Unsupported value in semantic input ' + field, 'invalid_input_shape');
}

function safeInput(value, source = 'model') {
  if (value == null) return Object.freeze({});
  if (!plain(value)) throw invalid('Semantic action input must be an object', 'invalid_input_shape');
  const pairs = Object.entries(value);
  if (pairs.length > MAX_INPUT_FIELDS) throw invalid('Too many semantic input fields', 'oversized_input');
  const result = Object.create(null);
  for (const [key, item] of pairs) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)
      || ['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw invalid('Invalid semantic input field', 'invalid_input_shape');
    }
    if (source === 'model' && RESERVED_MODEL_FIELDS.has(key)) {
      throw invalid('Model input cannot assert a trusted identity or authorization', 'untrusted_identity_field');
    }
    if (item !== undefined && item !== null) result[key] = safeValue(item, key);
  }
  return Object.freeze(result);
}

function normalizedConfidence(value) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
}

function normalizedAction(value) {
  const action = String(value || 'NO_ACTION').trim().toUpperCase();
  if (!CONTROLS.has(action) && !VOICE_ACTIONS.has(action)) {
    throw invalid('The model proposed an unavailable voice action', 'unknown_or_forbidden_action');
  }
  return action;
}

function inferredType(action) {
  if (action === 'CLARIFY') return 'clarification';
  if (action === 'CANCEL_TASK') return 'cancellation';
  if (action === 'CORRECT_TASK') return 'correction';
  if (action === 'NEW_TOPIC' || action === 'RESUME_TASK' || action === 'NO_ACTION') return 'conversation_only';
  if (READ_ACTIONS.has(action)) return 'question';
  if (REPORT_ACTIONS.has(action)) return 'observation';
  return 'action_request';
}

function interpretType(value, action, source = 'model') {
  if (value === undefined || value === null) return inferredType(action);
  if (typeof value !== 'string' || !TYPES.has(value)) {
    throw invalid('Unknown semantic interpretation type', 'invalid_intent_type');
  }
  // Addressing is decided before STT planning by the authenticated gate.
  if (value === 'unaddressed') throw invalid('Only the trusted radio gate determines addressing', 'untrusted_address_decision');
  if (value === 'question' && action !== 'NO_ACTION' && !READ_ACTIONS.has(action)) {
    throw invalid('A question cannot be a CAD mutation', 'question_mutation_conflict');
  }
  if (value === 'observation' && action !== 'NO_ACTION' && !REPORT_ACTIONS.has(action)) {
    throw invalid('An observation cannot change status or unrelated CAD records', 'observation_mutation_conflict');
  }
  if (value === 'conversation_only' && !['NO_ACTION', 'NEW_TOPIC', 'RESUME_TASK'].includes(action)) {
    throw invalid('Conversation-only traffic cannot execute a CAD action', 'conversation_mutation_conflict');
  }
  if (value === 'clarification' && action !== 'CLARIFY') {
    throw invalid('A clarification cannot silently execute an action', 'control_action_conflict');
  }
  if (value === 'cancellation' && action !== 'CANCEL_TASK') {
    throw invalid('Cancellation must use the owned-task cancellation operation', 'control_action_conflict');
  }
  if (value === 'correction' && action !== 'CORRECT_TASK') {
    throw invalid('Corrections must preserve task transition custody', 'control_action_conflict');
  }
  if (value === 'action_request' && CONTROLS.has(action)) {
    throw invalid('Task control is not a CAD action request', 'control_action_conflict');
  }
  return value;
}

function normalizeStep(raw, source, index, earlier) {
  if (!plain(raw) || typeof raw.action !== 'string'
    || Object.keys(raw).some(key => !['id', 'action', 'input', 'dependsOn', 'callIdFrom'].includes(key))) {
    throw invalid('Each semantic step needs one supported action and trusted step fields', 'invalid_step');
  }
  const action = normalizedAction(raw.action);
  if (CONTROLS.has(action)) throw invalid('A compound plan cannot contain dialogue controls', 'invalid_step');
  const id = raw.id === undefined ? 'step' + (index + 1) : raw.id;
  if (typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(id)
    || earlier.some(step => step.id === id)) throw invalid('Invalid or duplicate compound step ID', 'invalid_step_id');
  const dependsOn = raw.dependsOn === undefined
    ? (earlier.length ? [earlier[earlier.length - 1].id] : []) : raw.dependsOn;
  if (!Array.isArray(dependsOn) || dependsOn.length > earlier.length
    || dependsOn.some(dep => typeof dep !== 'string' || !earlier.some(step => step.id === dep))
    || new Set(dependsOn).size !== dependsOn.length) {
    throw invalid('A step may depend only on unique, earlier operations', 'invalid_step_dependency');
  }
  const input = safeInput(raw.input, source);
  const callIdFrom = raw.callIdFrom;
  if (callIdFrom !== undefined && (typeof callIdFrom !== 'string'
    || !CALL_TARGET_ACTIONS.has(action) || !dependsOn.includes(callIdFrom)
    || input.callId || input.callRef
    || !['CREATE_CALL', 'GET_CALL', 'GET_CURRENT_CALL'].includes(earlier.find(step => step.id === callIdFrom)?.action))) {
    throw invalid('Invalid call binding: use an earlier call-producing dependency, not an invented ID', 'invalid_step_call_binding');
  }
  return Object.freeze({ id, action, input, dependsOn: Object.freeze([...dependsOn]),
    ...(callIdFrom === undefined ? {} : { callIdFrom }) });
}

// This is the only normalization function used by BOTH planning paths.
// A model-supplied classification is validated against its chosen action.
// Legacy test/providers without intentType remain safe and infer it from action.
export function normalizeV3SemanticPlan(raw, { source = 'model' } = {}) {
  if (!plain(raw)) throw invalid('Semantic model response must be an object', 'invalid_plan_shape');
  if (raw.actions !== undefined) {
    if (!Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > MAX_PLAN_ACTIONS) {
      throw invalid('Compound action count is invalid', 'invalid_step_count');
    }
    if (raw.action && String(raw.action).trim().toUpperCase() !== 'MULTI_ACTION') {
      throw invalid('Conflicting single and compound actions', 'conflicting_actions');
    }
    const ordered = [];
    for (let index = 0; index < raw.actions.length; index++) {
      ordered.push(normalizeStep(raw.actions[index], source, index, ordered));
    }
    const actions = Object.freeze(ordered);
    const readOnly = actions.every(item => READ_ACTIONS.has(item.action));
    const intentType = interpretType(raw.intentType, readOnly ? V3_ACTIONS.GET_CALL : V3_ACTIONS.SET_UNIT_STATUS, source);
    if (!['question', 'action_request'].includes(intentType)) {
      throw invalid('Compound operations require a question or action request', 'compound_intent_conflict');
    }
    return Object.freeze({
      action: 'MULTI_ACTION', intentType, actions,
      input: Object.freeze({}), confidence: normalizedConfidence(raw.confidence),
      clarification: null, reason: bounded(raw.reason, 200) || null,
    });
  }

  const action = normalizedAction(raw.action);
  const intentType = interpretType(raw.intentType, action, source);
  const clarification = bounded(raw.clarification, 180) || null;
  if (action === 'CLARIFY' && !clarification) {
    throw invalid('A clarification needs a specific question', 'missing_clarification');
  }
  if (action !== 'CLARIFY' && raw.pendingTask != null) {
    throw invalid('Only a clarification may propose an unfinished task', 'invalid_pending_task');
  }
  const pendingTask = action === 'CLARIFY' && raw.pendingTask != null
    ? normalizeV3PendingTaskProposal(raw.pendingTask) : null;
  return Object.freeze({
    action, intentType, input: safeInput(raw.input, source),
    confidence: normalizedConfidence(raw.confidence),
    clarification, reason: bounded(raw.reason, 200) || null,
    ...(pendingTask ? { pendingTask } : {}),
  });
}

export function listV3SemanticCapabilities(runtimeContext = null) {
  // A standalone pure planner has no caller scopes. In live V3 the normalized
  // runtime ALWAYS supplies a scopes array and must fail closed when empty.
  const scoped = Array.isArray(runtimeContext?.scopes);
  return Object.freeze([...VOICE_ACTIONS].filter(action => {
    const requirements = getV3ActionDefinition(action).scopes;
    return !scoped || requirements.every(scope => hasV3Scope(runtimeContext, scope));
  }).map(action => Object.freeze({
    action,
    requiredScopes: Object.freeze([...getV3ActionDefinition(action).scopes]),
    readOnly: READ_ACTIONS.has(action),
  })));
}

function sanitizeInputForModel(input) {
  if (!plain(input)) return {};
  const result = {};
  for (const [key, value] of Object.entries(input).slice(0, 24)) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || value == null) continue;
    if (typeof value === 'string') result[key] = bounded(value, 180);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'boolean') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.slice(0, 12)
      .filter(item => typeof item === 'string' || typeof item === 'number')
      .map(item => bounded(item, 80));
  }
  return result;
}

function sanitizeRecent(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-6).map(item => ({
    transcript: bounded(item?.transcript, 240),
    action: bounded(item?.action, 40),
    input: sanitizeInputForModel(item?.input),
    clarification: bounded(item?.clarification, 180),
    success: item?.success === true,
  }));
}

function sanitizeSharedIncident(view) {
  if (!view || view.verifiedCadFacts !== true
    || view.provenance !== 'fresh_center_authorized_cad') return null;
  const output = {};
  for (const key of ['callId', 'callNumber', 'nature', 'location', 'status', 'priority', 'provenance']) {
    output[key] = bounded(view[key], 160) || null;
  }
  output.verifiedCadFacts = true;
  output.participatingUnits = Array.isArray(view.participatingUnits)
    ? view.participatingUnits.slice(0, 12).map(value => bounded(value, 80)).filter(Boolean) : [];
  output.reportCount = Number.isInteger(view.reportCount) ? Math.max(0, Math.min(8, view.reportCount)) : 0;
  return output;
}

// Only the verified caller is the speaker. Names in the transcript are
// candidate targets for existing CAD resolution, never speaker authority.
export function buildV3SemanticModelContext({
  transcript, speakerCallsign, runtimeContext, turnEnvelope = null,
  operationalContext = null, sharedIncident = null, pendingContext = null,
  dialogueContext = null, recentContext = [],
} = {}) {
  const capabilities = listV3SemanticCapabilities(runtimeContext);
  const speaker = turnEnvelope?.speaker || null;
  return Object.freeze({
    transcript: String(transcript || '').trim(),
    speakerCallsign: speaker?.callsign || speakerCallsign || null,
    speaker: Object.freeze({
      callsign: speaker?.callsign || speakerCallsign || null,
      unitId: speaker?.unitId || null,
      verifiedFromTrustedPtt: !!speaker,
    }),
    dispatchCenterId: runtimeContext?.dispatchCenterId || null,
    channel: runtimeContext?.roomKey || null,
    availableActions: capabilities.map(item => item.action),
    toolCapabilities: capabilities,
    operationalContext: sanitizeV3OperationalContext(operationalContext),
    sharedIncident: sanitizeSharedIncident(sharedIncident),
    pendingContext: pendingV3TaskForModel(pendingContext) || sanitizeInputForModel(pendingContext),
    dialogueContext: sanitizeInputForModel(dialogueContext),
    recentContext: sanitizeRecent(recentContext),
  });
}
