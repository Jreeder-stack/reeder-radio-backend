import { validateV3ActionRequest, V3_ACTIONS } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES, asDispatcherV3Error } from './errors.js';
import { ensureV3CorrelationId } from './correlation.js';
import { recordV3Diagnostic } from './diagnostics.js';
import { assertV3TurnEnvelope, currentV3TurnEnvelope } from './turnEnvelope.js';
import { assertV3DeadlineActive } from './operationDeadline.js';
import { authorizeV3Life, currentV3Life } from './turnLifecycle.js';

const REQUIRED_READBACK = new Set([
  V3_ACTIONS.SET_UNIT_STATUS, V3_ACTIONS.CHANGE_UNIT_ZONE, V3_ACTIONS.CREATE_CALL,
  V3_ACTIONS.UPDATE_CALL, V3_ACTIONS.ADD_CALL_NOTE, V3_ACTIONS.ASSIGN_UNIT,
  V3_ACTIONS.UNASSIGN_UNIT, V3_ACTIONS.MAKE_PRIMARY,
  V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES, V3_ACTIONS.CLEAR_UNIT, V3_ACTIONS.CLOSE_CALL,
]);
const READ_ACTIONS = new Set([
  V3_ACTIONS.RADIO_CHECK, V3_ACTIONS.TIME_CHECK, V3_ACTIONS.STATUS_CHECK,
  V3_ACTIONS.GET_CURRENT_CALL, V3_ACTIONS.GET_CALL, V3_ACTIONS.LIST_ACTIVE_CALLS,
  V3_ACTIONS.SEARCH_CALLS,
]);

export class V3ActionExecutor {
  constructor({ runtimeContext, handlers = {}, diagnostics = null, now = () => Date.now(), requireTurnIdentity = false } = {}) {
    this.runtimeContext = runtimeContext;
    this.handlers = new Map(Object.entries(handlers));
    this.diagnostics = diagnostics;
    this.now = now;
    this.requireTurnIdentity = requireTurnIdentity;
  }

  register(action, handler) {
    const normalized = String(action || '').trim().toUpperCase();
    if (!Object.values(V3_ACTIONS).includes(normalized)) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION, `Cannot register unknown V3 action: ${normalized}`);
    }
    if (typeof handler !== 'function') {
      throw new TypeError(`Handler for ${normalized} must be a function`);
    }
    this.handlers.set(normalized, handler);
    return this;
  }

  async execute(request = {}, options = {}) {
    const turnEnvelope = options.turnEnvelope || currentV3TurnEnvelope();
    const correlationId = ensureV3CorrelationId(options.correlationId || request.correlationId, this.runtimeContext?.runtimeId);
    const startedAt = this.now();
    const life = currentV3Life();
    const writesBefore = life?.writeCount || 0;
    const baseDiagnostic = {
      correlationId,
      runtimeId: this.runtimeContext?.runtimeId || null,
      dispatchCenterId: this.runtimeContext?.dispatchCenterId || null,
      channelId: this.runtimeContext?.channelId || null,
      action: String(request.action || '').trim().toUpperCase() || null,
      turnEnvelope,
    };

    recordV3Diagnostic(this.diagnostics, {
      ...baseDiagnostic,
      phase: 'action_received',
      details: { input: request.input || {} },
    });

    try {
      if (this.requireTurnIdentity || turnEnvelope) assertV3TurnEnvelope(turnEnvelope, this.runtimeContext);
      const validated = validateV3ActionRequest(request, this.runtimeContext);
      recordV3Diagnostic(this.diagnostics, {
        ...baseDiagnostic,
        action: validated.action,
        phase: 'action_validated',
        details: { input: validated.input, scopes: validated.scopes },
      });

      const handler = this.handlers.get(validated.action);
      if (!handler) {
        throw new DispatcherV3Error(
          V3_ERROR_CODES.INVALID_ACTION,
          `No V3 executor handler is registered for ${validated.action}`,
          { statusCode: 501, details: { action: validated.action } },
        );
      }

      // Revalidate actor/channel grant after planning and before every action.
      await authorizeV3Life();
      assertV3DeadlineActive();
      const data = await handler({
        action: validated.action,
        input: validated.input,
        runtimeContext: this.runtimeContext,
        correlationId,
        turnEnvelope,
        // Internal-only, stricter follow-up revalidation. Model input is
        // always stripped by the action contract and cannot supply this hook.
        beforeCadWrite: typeof options.beforeCadWrite === 'function' ? options.beforeCadWrite : null,
      });

      assertV3DeadlineActive();
      if (typeof data?.verified === 'boolean') {
        recordV3Diagnostic(this.diagnostics, {
          ...baseDiagnostic, action: validated.action,
          phase: 'cad_verification_outcome', success: data.verified,
          latencyMs: this.now() - startedAt,
          details: { verified: data.verified, code: data.verified ? null : 'UNVERIFIED' },
        });
      }
      const partialErrors = Array.isArray(data?.partialErrors) ? data.partialErrors : [];
      const incompleteReport = partialErrors.length > 0 || (data?.deferredCount || 0) > 0
        || (validated.action === V3_ACTIONS.REQUEST_BACKUP
          && data?.cadNote?.skipped !== true && data?.cadNote?.recorded === false);
      const unverified = REQUIRED_READBACK.has(validated.action) && data?.verified !== true;
      const outcome = incompleteReport ? 'partial' : unverified ? 'unknown'
        : data?.verified === true ? 'verified'
          : READ_ACTIONS.has(validated.action) ? 'read_success' : 'completed';
      const success = !incompleteReport && !unverified && data?.success !== false;
      const submittedWrites = Math.max(0, (life?.writeCount || 0) - writesBefore);
      if (success && data?.verified === true && life) life.owner.settleVerified(life, submittedWrites);
      const result = Object.freeze({
        success, outcome, action: validated.action, correlationId,
        submittedWrites, data: data ?? null,
        ...(success ? {} : { error: Object.freeze({
          code: V3_ERROR_CODES.CAD_REJECTED, retryable: false,
          message: incompleteReport ? 'The CAD request was partially recorded'
            : 'CAD could not independently verify the requested mutation',
          details: { possibleUnconfirmedWrite: unverified
            || partialErrors.some(item => item.outcome === 'unknown'), partialErrors },
        }) }),
        ...(turnEnvelope ? { turnEnvelope } : {}),
      });
      recordV3Diagnostic(this.diagnostics, {
        ...baseDiagnostic, action: validated.action,
        phase: success ? 'action_completed' : 'action_partial_or_unknown',
        success, latencyMs: this.now() - startedAt,
        details: { outcome, submittedWrites, partialErrors: partialErrors.length },
      });
      return result;
    } catch (error) {
      const normalized = asDispatcherV3Error(error, 'Dispatcher V3 action execution failed');
      const submittedWrites = Math.max(0, (life?.writeCount || 0) - writesBefore);
      let reconciliation = null;
      if (submittedWrites > 0 && typeof options.reconcileUnknown === 'function') {
        try {
          await authorizeV3Life();
          assertV3DeadlineActive();
          reconciliation = await options.reconcileUnknown({
            action: String(request.action || '').toUpperCase(),
            input: request.input || {}, correlationId, turnEnvelope,
          });
        } catch (_) { reconciliation = null; }
      }
      const verified = reconciliation?.verified === true;
      if (verified && life) life.owner.settleVerified(life, submittedWrites);
      const result = Object.freeze({
        success: verified, outcome: verified ? 'verified' : submittedWrites ? 'unknown' : 'failed',
        action: String(request.action || '').trim().toUpperCase() || null,
        correlationId, submittedWrites,
        ...(turnEnvelope ? { turnEnvelope } : {}),
        ...(verified ? { data: { ...reconciliation.data, verified: true,
          reconciliation: 'fresh_cad_state_after_uncertain_write' } } : {}),
        error: verified ? null : Object.freeze({
          code: normalized.code, message: normalized.message, statusCode: normalized.statusCode,
          retryable: submittedWrites ? false : normalized.retryable,
          details: { ...(normalized.details || {}), ...(submittedWrites
            ? { possibleUnconfirmedWrite: true, doNotRetry: true,
              reconciliation: reconciliation?.observation || 'unresolved' } : {}) },
        }),
      });
      recordV3Diagnostic(this.diagnostics, {
        ...baseDiagnostic, phase: verified ? 'cad_write_reconciled' : 'action_failed',
        success: verified, latencyMs: this.now() - startedAt,
        details: { outcome: result.outcome, submittedWrites, code: result.error?.code || null },
      });
      return result;
    }
  }
}
