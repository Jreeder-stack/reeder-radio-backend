// AI-DISP-V3-001 / 02-02. An unanswered question retains an operation,
// not an executable authorization. CAD and speaker permissions are checked again
// on the answering turn. No persistent CAD facts live in this record.
import { V3_ACTIONS, listV3Actions } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const TASK_ACTIONS = new Set(listV3Actions().filter((action) => action !== V3_ACTIONS.DECLARE_EMERGENCY));
const CLARIFIABLE_FIELDS = new Set([
  'callId', 'callRef', 'unitRef', 'location', 'type', 'zone',
  'disposition', 'note', 'status', 'informationType', 'value',
]);
const CALL_ERRORS = new Set([V3_ERROR_CODES.CALL_AMBIGUOUS, V3_ERROR_CODES.CALL_NOT_FOUND]);
const UNIT_ERRORS = new Set([V3_ERROR_CODES.UNIT_AMBIGUOUS, V3_ERROR_CODES.UNIT_NOT_FOUND]);
const MAX_CANDIDATES = 12;
const FORBIDDEN_MODEL_FIELDS = new Set([
  'unitId', 'unitIds', 'accountId', 'dispatchCenterId', 'runtimeGeneration',
  'scopes', 'verified', 'authorized', 'permissionGrants', 'beforeCadWrite',
  'speakerUnitId', 'profileId', 'runtimeId', 'connectionId',
]);

const clean = (value, limit = 180) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, limit) : '';
const candidateId = (item) => clean(
  typeof item === 'string' ? item : item?.id || item?.callId || item?.call_id || item?.unitId || item?.unit_id,
  100,
);
const uniqueIds = (items) => [...new Set((Array.isArray(items) ? items : []).map(candidateId).filter(Boolean))].slice(0, MAX_CANDIDATES);

function invalid(message) {
  return new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, message, { statusCode: 400 });
}

// Keep structured input, including limited unitRefs, but no arbitrary nested
// payloads or model-provided authorization and no synthesized CAD snapshots.
function boundedInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const input = {};
  for (const [key, value] of Object.entries(raw).slice(0, 32)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)
      || FORBIDDEN_MODEL_FIELDS.has(key)) {
      throw invalid('Untrusted task input contains a forbidden identity or permission field');
    }
    if (value == null) continue;
    if (typeof value === 'string') input[key] = clean(value, 250);
    else if (typeof value === 'boolean') input[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) input[key] = value;
    else if (Array.isArray(value) && value.length <= 12
      && value.every((entry) => ['string', 'number', 'boolean'].includes(typeof entry))) {
      input[key] = value.map((entry) => typeof entry === 'string' ? clean(entry, 180) : entry);
    } else throw invalid('Clarification contains an unsupported task parameter');
  }
  return input;
}

// Normalize the model's *proposed* intent. The model can never supply task
// ownership, original turn, trusted candidates or permission grants.
export function normalizeV3PendingTaskProposal(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('Clarification task must be an object');
  const action = clean(raw.action, 40).toUpperCase();
  if (!TASK_ACTIONS.has(action)) throw invalid('Clarification must reference a supported non-emergency operation');
  const unresolvedField = clean(raw.unresolvedField, 40);
  if (!CLARIFIABLE_FIELDS.has(unresolvedField)) throw invalid('Clarification must identify one supported unresolved field');
  return Object.freeze({
    action,
    input: Object.freeze(boundedInput(raw.input)),
    unresolvedField,
    // Hints are *not* authoritative. Candidate IDs are independently scoped
    // against the current CAD snapshot when the task is recorded.
    candidateIds: Object.freeze(uniqueIds(raw.candidateIds)),
  });
}

export function createV3PendingTask({ plan, error = null, operationalContext = null, turnEnvelope } = {}) {
  if (!turnEnvelope?.turnId || !turnEnvelope?.speaker?.unitId) return null;
  const fromModel = plan?.action === 'CLARIFY' ? plan.pendingTask || null : null;
  const fromResolution = plan?.action !== 'CLARIFY' && (CALL_ERRORS.has(error?.code) || UNIT_ERRORS.has(error?.code))
    ? { action: plan.action, input: plan.input, unresolvedField: CALL_ERRORS.has(error.code) ? 'callId' : 'unitRef' }
    : null;
  const source = fromModel || fromResolution;
  if (!source) return null;

  const proposed = normalizeV3PendingTaskProposal(source);
  const input = boundedInput(proposed.input);
  const originalCallId = clean(input.callId, 100) || null;
  const originalCallRef = clean(input.callRef, 180) || null;
  const activeCallIds = uniqueIds(operationalContext?.activeCalls || []);
  let candidates = [];
  if (proposed.unresolvedField === 'callId' || proposed.unresolvedField === 'callRef') {
    const authoritative = CALL_ERRORS.has(error?.code) && Array.isArray(error?.details?.candidates)
      ? uniqueIds(error.details.candidates) : activeCallIds;
    const hinted = fromModel?.candidateIds?.length ? proposed.candidateIds : [];
    candidates = hinted.length ? authoritative.filter((id) => hinted.includes(id)) : authoritative;
    // Do not accidentally turn a resolved call ID into a second target.
    if (proposed.unresolvedField === 'callId') delete input.callId;
  } else if (proposed.unresolvedField === 'unitRef') {
    candidates = UNIT_ERRORS.has(error?.code) ? uniqueIds(error?.details?.candidates) : [];
    delete input.unitRef;
  }

  return Object.freeze({
    action: proposed.action,
    input: Object.freeze(input),
    unresolvedField: proposed.unresolvedField,
    candidateIds: Object.freeze(candidates),
    originalTurnId: turnEnvelope.turnId,
    // Historical references, not authoritative current-call or assignment data.
    callRelationship: Object.freeze({
      speakerUnitId: turnEnvelope.speaker.unitId,
      requestedCallId: originalCallId,
      requestedCallRef: originalCallRef,
      currentCallIdAtRequest: candidateId(operationalContext?.currentCall) || null,
    }),
  });
}

export function pendingV3TaskForModel(pending) {
  if (pending?.kind !== 'task_clarification' || !pending.pendingTask) return null;
  const task = pending.pendingTask;
  return {
    kind: 'task_clarification', taskId: clean(pending.taskId, 100),
    originalTurnId: clean(task.originalTurnId, 100),
    intendedAction: task.action, resolvedInput: boundedInput(task.input),
    unresolvedField: task.unresolvedField, candidateIds: uniqueIds(task.candidateIds),
    callRelationship: { ...task.callRelationship },
    clarification: clean(pending.clarification, 180),
  };
}

function stillActiveCall(operationalContext, callId) {
  return Array.isArray(operationalContext?.activeCalls)
    && operationalContext.activeCalls.some((call) => candidateId(call) === callId);
}

// Only the field asked about may be filled. The answering model cannot replace
// the original action, unit, note, disposition or other saved constraints.
export async function resumeV3PendingTask({
  pendingTask, answer, operationalContext, operationalContextService,
  unitIdentityService, correlationId, turnEnvelope,
} = {}) {
  if (!pendingTask || answer?.action !== pendingTask.action) return null;
  if (pendingTask.callRelationship?.speakerUnitId !== turnEnvelope?.speaker?.unitId) {
    throw invalid('Clarification speaker does not own the original task');
  }
  const field = pendingTask.unresolvedField;
  const answerInput = answer.input || {};
  let value = answerInput[field];

  if (field === 'callId' || field === 'callRef') {
    if (!operationalContext || !operationalContextService) throw invalid('Current CAD call context is required');
    const explicitId = clean(answerInput.callId, 100);
    const reference = clean(answerInput.callRef, 180);
    if (!explicitId && !reference) throw invalid('The call was not identified');
    const resolvedId = explicitId || await operationalContextService.resolveCallId({
      callRef: reference, operationalContext, preferCurrentCall: false, correlationId,
    });
    if (!stillActiveCall(operationalContext, resolvedId)) throw invalid('The selected call is no longer active');
    if (pendingTask.candidateIds?.length && !pendingTask.candidateIds.includes(resolvedId)) {
      throw invalid('The selected call was not among the original candidates');
    }
    const previous = pendingTask.callRelationship?.currentCallIdAtRequest;
    if (previous && pendingTask.action === V3_ACTIONS.ASSIGN_UNIT
      && candidateId(operationalContext.currentCall) !== previous) {
      throw invalid('The unit call relationship changed during clarification');
    }
    value = resolvedId;
  } else if (field === 'unitRef') {
    const requested = clean(value, 100);
    if (!requested || !unitIdentityService) throw invalid('The unit was not identified');
    if (pendingTask.candidateIds?.length) {
      const identity = await unitIdentityService.resolve(requested, { correlationId });
      if (!pendingTask.candidateIds.includes(identity.unitId)) throw invalid('The unit was not among the original candidates');
    }
    value = requested;
  } else if (!clean(value, 250)) {
    throw invalid('The requested information is still missing');
  }

  const input = { ...boundedInput(pendingTask.input) };
  if (field === 'callId' || field === 'callRef') {
    delete input.callRef;
    input.callId = value;
  } else input[field] = value;

  return Object.freeze({
    action: pendingTask.action,
    input: Object.freeze(input),
    confidence: answer.confidence,
    clarification: null,
    reason: 'clarified_original_task',
  });
}
