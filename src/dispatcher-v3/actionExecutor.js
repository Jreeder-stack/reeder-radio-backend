import { validateV3ActionRequest, V3_ACTIONS } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES, asDispatcherV3Error } from './errors.js';
import { ensureV3CorrelationId } from './correlation.js';
import { recordV3Diagnostic } from './diagnostics.js';

export class V3ActionExecutor {
  constructor({ runtimeContext, handlers = {}, diagnostics = null, now = () => Date.now() } = {}) {
    this.runtimeContext = runtimeContext;
    this.handlers = new Map(Object.entries(handlers));
    this.diagnostics = diagnostics;
    this.now = now;
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
    const correlationId = ensureV3CorrelationId(options.correlationId || request.correlationId, this.runtimeContext?.runtimeId);
    const startedAt = this.now();
    const baseDiagnostic = {
      correlationId,
      runtimeId: this.runtimeContext?.runtimeId || null,
      dispatchCenterId: this.runtimeContext?.dispatchCenterId || null,
      channelId: this.runtimeContext?.channelId || null,
      action: String(request.action || '').trim().toUpperCase() || null,
    };

    recordV3Diagnostic(this.diagnostics, {
      ...baseDiagnostic,
      phase: 'action_received',
      details: { input: request.input || {} },
    });

    try {
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

      const data = await handler({
        action: validated.action,
        input: validated.input,
        runtimeContext: this.runtimeContext,
        correlationId,
      });

      const result = Object.freeze({
        success: true,
        action: validated.action,
        correlationId,
        data: data ?? null,
      });

      recordV3Diagnostic(this.diagnostics, {
        ...baseDiagnostic,
        action: validated.action,
        phase: 'action_completed',
        success: true,
        latencyMs: this.now() - startedAt,
        details: { result: data ?? null },
      });
      return result;
    } catch (error) {
      const normalized = asDispatcherV3Error(error, 'Dispatcher V3 action execution failed');
      const result = Object.freeze({
        success: false,
        action: String(request.action || '').trim().toUpperCase() || null,
        correlationId,
        error: Object.freeze({
          code: normalized.code,
          message: normalized.message,
          statusCode: normalized.statusCode,
          retryable: normalized.retryable,
          details: normalized.details,
        }),
      });

      recordV3Diagnostic(this.diagnostics, {
        ...baseDiagnostic,
        phase: 'action_failed',
        success: false,
        latencyMs: this.now() - startedAt,
        details: { error: result.error },
      });
      return result;
    }
  }
}
