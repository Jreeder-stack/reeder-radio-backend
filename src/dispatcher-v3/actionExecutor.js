import { validateV3ActionRequest, V3_ACTIONS } from './actionContracts.js';
import { DispatcherV3Error, V3_ERROR_CODES, asDispatcherV3Error } from './errors.js';
import { ensureV3CorrelationId } from './correlation.js';

export class V3ActionExecutor {
  constructor({ runtimeContext, handlers = {} } = {}) {
    this.runtimeContext = runtimeContext;
    this.handlers = new Map(Object.entries(handlers));
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
    try {
      const validated = validateV3ActionRequest(request, this.runtimeContext);
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

      return Object.freeze({
        success: true,
        action: validated.action,
        correlationId,
        data: data ?? null,
      });
    } catch (error) {
      const normalized = asDispatcherV3Error(error, 'Dispatcher V3 action execution failed');
      return Object.freeze({
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
    }
  }
}
