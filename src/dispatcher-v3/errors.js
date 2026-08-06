export const V3_ERROR_CODES = Object.freeze({
  INVALID_RUNTIME_CONTEXT: 'INVALID_RUNTIME_CONTEXT',
  DISPATCH_CENTER_REQUIRED: 'DISPATCH_CENTER_REQUIRED',
  CHANNEL_REQUIRED: 'CHANNEL_REQUIRED',
  INVALID_ACTION: 'INVALID_ACTION',
  INVALID_ACTION_INPUT: 'INVALID_ACTION_INPUT',
  UNIT_NOT_FOUND: 'UNIT_NOT_FOUND',
  UNIT_AMBIGUOUS: 'UNIT_AMBIGUOUS',
  CAD_UNAVAILABLE: 'CAD_UNAVAILABLE',
  CAD_REJECTED: 'CAD_REJECTED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export class DispatcherV3Error extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DispatcherV3Error';
    this.code = code || V3_ERROR_CODES.INTERNAL_ERROR;
    this.statusCode = options.statusCode ?? null;
    this.retryable = options.retryable === true;
    this.details = options.details ?? null;
    this.cause = options.cause;
  }

  toResult() {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        retryable: this.retryable,
        details: this.details,
      },
    };
  }
}

export function asDispatcherV3Error(error, fallbackMessage = 'Dispatcher V3 operation failed') {
  if (error instanceof DispatcherV3Error) return error;
  return new DispatcherV3Error(
    V3_ERROR_CODES.INTERNAL_ERROR,
    error?.message || fallbackMessage,
    { cause: error },
  );
}
