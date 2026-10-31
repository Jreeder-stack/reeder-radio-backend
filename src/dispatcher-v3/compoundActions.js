// AI-DISP-V3-001 / 03-03. Ordered, dependency-aware V3 CAD operations.
// No transaction or rollback is implied. Every operation uses the original
// materializer, authenticated executor, and independent CAD read-back.
import { V3_ACTIONS } from './actionContracts.js';
import { V3_ERROR_CODES, asDispatcherV3Error } from './errors.js';
import { assertV3DeadlineActive } from './operationDeadline.js';

const VERIFIED_WRITES = new Set([
  V3_ACTIONS.SET_UNIT_STATUS, V3_ACTIONS.CHANGE_UNIT_ZONE,
  V3_ACTIONS.CREATE_CALL, V3_ACTIONS.UPDATE_CALL, V3_ACTIONS.ADD_CALL_NOTE,
  V3_ACTIONS.ASSIGN_UNIT, V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY,
  V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES, V3_ACTIONS.CLEAR_UNIT, V3_ACTIONS.CLOSE_CALL,
]);
const READS = new Set([
  V3_ACTIONS.RADIO_CHECK, V3_ACTIONS.TIME_CHECK, V3_ACTIONS.STATUS_CHECK,
  V3_ACTIONS.GET_CURRENT_CALL, V3_ACTIONS.GET_CALL, V3_ACTIONS.LIST_ACTIVE_CALLS,
  V3_ACTIONS.SEARCH_CALLS,
]);
const CALL_TARGETS = new Set([
  V3_ACTIONS.GET_CALL, V3_ACTIONS.UPDATE_CALL, V3_ACTIONS.ADD_CALL_NOTE,
  V3_ACTIONS.ASSIGN_UNIT, V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY,
  V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES, V3_ACTIONS.CLEAR_UNIT, V3_ACTIONS.CLOSE_CALL,
]);
const CALL_PRODUCERS = new Set([
  V3_ACTIONS.CREATE_CALL, V3_ACTIONS.GET_CALL, V3_ACTIONS.GET_CURRENT_CALL,
]);
const DEPENDENCY_READY = new Set(['verified', 'read_success', 'duplicate_skipped']);
const FINISHED = new Set(['verified', 'read_success', 'duplicate_skipped', 'completed']);

function errorData(error) {
  const normalized = asDispatcherV3Error(error);
  return {
    code: normalized.code, message: normalized.message,
    statusCode: normalized.statusCode, retryable: false,
  };
}

function inputKey(action, input) {
  const sorted = Object.keys(input || {}).sort().map(key => [key, input[key]]);
  return JSON.stringify([action, sorted]);
}

function callIdFromResult(step) {
  if (!step || !DEPENDENCY_READY.has(step.status) || !CALL_PRODUCERS.has(step.action)) return null;
  const call = step.result?.data?.call || step.result?.data?.assignment || null;
  const id = call?.call_id || call?.callId || call?.id || null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

// Only the dependency graph created by the semantic contract may supply the
// new-call reference. Never use a model-invented server ID or a stale current
// call to bind a dependent operation.
function findBoundCallStep(actionPlan, definitions) {
  if (!CALL_TARGETS.has(actionPlan.action)
    || actionPlan.input?.callId || actionPlan.input?.callRef) return null;
  if (actionPlan.callIdFrom) return actionPlan.callIdFrom;
  const visited = new Set();
  const candidates = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    visited.add(id);
    const step = definitions.get(id);
    if (!step) return;
    if (step.action === V3_ACTIONS.CREATE_CALL) candidates.add(id);
    else for (const parent of step.dependsOn || []) visit(parent);
  };
  for (const id of actionPlan.dependsOn || []) visit(id);
  return candidates.size === 1 ? [...candidates][0] : null;
}

function summarize(steps) {
  return Object.freeze({
    total: steps.length,
    verified: steps.filter(step => step.status === 'verified').length,
    reads: steps.filter(step => step.status === 'read_success').length,
    duplicateSkipped: steps.filter(step => step.status === 'duplicate_skipped').length,
    completedWithoutCadVerification: steps.filter(step => step.status === 'completed').length,
    failed: steps.filter(step => step.status === 'failed' || step.status === 'partial').length,
    unknown: steps.filter(step => step.status === 'unknown').length,
    notAttempted: steps.filter(step => step.status === 'skipped_dependency').length,
  });
}

export async function executeV3CompoundPlan({
  plan, materialize, execute, snapshot = null, submittedWrites = () => 0,
  operationalContext = null, correlationId = null, turnEnvelope = null,
  assertActive = assertV3DeadlineActive, onStep = null,
} = {}) {
  if (!Array.isArray(plan?.actions) || plan.actions.length < 1 || plan.actions.length > 10) {
    throw new TypeError('A bounded compound plan is required');
  }
  if (typeof materialize !== 'function' || typeof execute !== 'function') {
    throw new TypeError('Compound execution requires the existing materializer and executor');
  }
  const definitions = new Map(plan.actions.map((step, i) => [step.id || 'step' + (i + 1), step]));
  const steps = [];
  const recorded = new Map();
  let context = operationalContext;
  for (let i = 0; i < plan.actions.length; i++) {
    assertActive();
    const actionPlan = plan.actions[i];
    const id = actionPlan.id || 'step' + (i + 1);
    const dependsOn = Array.isArray(actionPlan.dependsOn)
      ? actionPlan.dependsOn : i ? [steps[i - 1].id] : [];
    const blockedBy = dependsOn.filter(dep => !DEPENDENCY_READY.has(recorded.get(dep)?.status));
    if (blockedBy.length) {
      const entry = Object.freeze({
        id, action: actionPlan.action, dependsOn, status: 'skipped_dependency',
        blockedBy, attempted: false,
      });
      steps.push(entry); recorded.set(id, entry); onStep?.(entry);
      continue;
    }

    const before = submittedWrites();
    let materialized = null;
    let result = null;
    let status;
    let failure = null;
    try {
      const input = { ...(actionPlan.input || {}) };
      const sourceId = findBoundCallStep({ ...actionPlan, input, dependsOn }, definitions);
      if (sourceId) {
        const callId = callIdFromResult(recorded.get(sourceId));
        if (!callId) {
          throw new Error('A verified or authorized call result is required before this dependent action');
        }
        input.callId = callId;
      }
      materialized = await materialize({ action: actionPlan.action, input }, context);
      assertActive();
      const fingerprint = inputKey(materialized.action, materialized.input);
      const previous = steps[steps.length - 1];
      if (VERIFIED_WRITES.has(materialized.action) && previous?.status === 'verified'
        && previous.fingerprint === fingerprint) {
        const entry = Object.freeze({
          id, action: materialized.action, dependsOn, callIdFrom: sourceId || null,
          input: materialized.input, status: 'duplicate_skipped',
          attempted: false, duplicateOf: previous.id, result: previous.result,
          fingerprint,
        });
        steps.push(entry); recorded.set(id, entry); onStep?.(entry);
        continue;
      }
      result = await execute(materialized);
      assertActive();
      if (result?.success === true) {
        if (VERIFIED_WRITES.has(materialized.action)) {
          status = result.data?.verified === true ? 'verified' : 'unknown';
          if (status === 'unknown') {
            failure = {
              code: V3_ERROR_CODES.CAD_REJECTED,
              message: 'CAD did not provide independent verification of the requested change',
            };
          }
        } else if (READS.has(materialized.action)) {
          status = 'read_success';
        } else if (Array.isArray(result.data?.partialErrors) && result.data.partialErrors.length) {
          status = 'partial';
          failure = { code: V3_ERROR_CODES.CAD_REJECTED, message: 'Part of the operational report was not recorded in CAD' };
        } else {
          // Existing non-CRUD operational handlers retain their own semantics.
          // This status is NOT proof of a CAD write or a dependency read-back.
          status = 'completed';
        }
      } else {
        status = result?.outcome === 'partial' ? 'partial'
          : result?.outcome === 'unknown' || submittedWrites() > before ? 'unknown' : 'failed';
        failure = result?.error || { code: V3_ERROR_CODES.CAD_UNAVAILABLE, message: 'CAD action did not complete' };
      }
      const entry = Object.freeze({
        id, action: materialized.action, dependsOn, callIdFrom: sourceId || null,
        input: materialized.input, status, attempted: true,
        submittedWrites: Math.max(0, submittedWrites() - before),
        fingerprint, result, ...(failure ? { error: failure } : {}),
      });
      steps.push(entry); recorded.set(id, entry); onStep?.(entry);
      if (DEPENDENCY_READY.has(status) && typeof snapshot === 'function') {
        try { context = await snapshot(); }
        catch { context = null; }
        assertActive();
      }
    } catch (error) {
      // Do not turn an expired/stopped-runtime operation into an audible
      // outcome. The existing turn lifetime owns cancellation.
      assertActive();
      const failureData = errorData(error);
      const entry = Object.freeze({
        id, action: actionPlan.action, dependsOn, status: submittedWrites() > before ? 'unknown' : 'failed',
        attempted: materialized !== null,
        submittedWrites: Math.max(0, submittedWrites() - before),
        error: failureData,
      });
      steps.push(entry); recorded.set(id, entry); onStep?.(entry);
    }
  }
  assertActive();
  const success = steps.every(step => FINISHED.has(step.status));
  const firstUnfinished = steps.find(step => !FINISHED.has(step.status));
  return Object.freeze({
    success, action: 'MULTI_ACTION', correlationId, turnEnvelope,
    data: Object.freeze({ steps: Object.freeze(steps), summary: summarize(steps) }),
    ...(success ? {} : {
      error: {
        code: firstUnfinished?.error?.code || V3_ERROR_CODES.CAD_REJECTED,
        message: 'Compound request partially completed or not verified',
        details: {
          failedStepId: firstUnfinished?.id || null,
          completedSteps: steps.filter(step => FINISHED.has(step.status)).map(step => step.id),
          notAttemptedSteps: steps.filter(step => !step.attempted).map(step => step.id),
          possibleUnconfirmedWrite: steps.some(step => step.status === 'unknown'),
        },
      },
    }),
  });
}
