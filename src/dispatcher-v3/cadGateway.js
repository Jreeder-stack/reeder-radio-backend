import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';
import { ensureV3CorrelationId } from './correlation.js';
import { validateV3RuntimeContext } from './runtimeContract.js';

const DEFAULT_TIMEOUT_MS = 8000;
const SAFE_RETRY_METHODS = new Set(['GET', 'HEAD']);

export class CommandLinkGateway {
  constructor(context, options = {}) {
    validateV3RuntimeContext(context);
    this.context = context;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.maxSafeRetries = Number.isInteger(options.maxSafeRetries) ? Math.max(0, options.maxSafeRetries) : 1;

    if (typeof this.fetchImpl !== 'function') {
      throw new DispatcherV3Error(
        V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT,
        'Dispatcher V3 Command Link gateway requires a fetch implementation',
      );
    }
  }

  async get(path, options = {}) {
    const response = await this.request(path, { ...options, method: 'GET' });
    return response.data;
  }

  async post(path, body, options = {}) {
    const response = await this.request(path, { ...options, method: 'POST', body });
    return response.data;
  }

  async patch(path, body, options = {}) {
    const response = await this.request(path, { ...options, method: 'PATCH', body });
    return response.data;
  }

  async requestData(path, options = {}) {
    const response = await this.request(path, options);
    return response.data;
  }

  async request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const correlationId = ensureV3CorrelationId(options.correlationId, this.context.runtimeId);
    const url = this._buildUrl(path, options.query);
    const headers = this._buildHeaders(options.headers, correlationId);
    const body = this._serializeBody(options.body, headers);
    const attempts = SAFE_RETRY_METHODS.has(method) ? 1 + this.maxSafeRetries : 1;

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this._execute({ url, method, headers, body, correlationId, attempt });
      } catch (error) {
        lastError = error;
        if (!this._shouldRetry(error, method, attempt, attempts)) throw error;
      }
    }
    throw lastError;
  }

  _buildUrl(path, query) {
    const rawPath = String(path || '').trim();
    if (!rawPath.startsWith('/')) {
      throw new DispatcherV3Error(
        V3_ERROR_CODES.INVALID_ACTION_INPUT,
        'Command Link gateway path must start with /',
      );
    }
    const url = new URL(`${this.context.cadUrl}${rawPath}`);
    url.searchParams.set('dispatch_center_id', this.context.dispatchCenterId);
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  _buildHeaders(extraHeaders, correlationId) {
    const headers = new Headers(extraHeaders || {});
    headers.set('Accept', 'application/json');
    headers.set('X-API-Key', this.context.cadApiKey);
    headers.set('X-Dispatch-Center-Id', this.context.dispatchCenterId);
    headers.set('X-Correlation-Id', correlationId);
    headers.set('X-Dispatcher-Runtime-Id', this.context.runtimeId);
    if (this.context.agencyId) headers.set('X-Agency-Id', this.context.agencyId);
    return headers;
  }

  _serializeBody(body, headers) {
    if (body === undefined || body === null) return undefined;
    if (typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
    headers.set('Content-Type', 'application/json');
    return JSON.stringify(body);
  }

  async _execute({ url, method, headers, body, correlationId, attempt }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    let response;
    try {
      response = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CAD_UNAVAILABLE,
        timedOut ? 'Command Link request timed out' : 'Command Link request failed',
        { retryable: true, cause: error, details: { correlationId, attempt, timedOut, method, url: redactUrl(url) } },
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = await parseResponseBody(response);
    const responseCorrelationId = response.headers?.get?.('x-correlation-id') || correlationId;
    if (!response.ok) {
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CAD_REJECTED,
        extractErrorMessage(payload, response.status),
        {
          statusCode: response.status,
          retryable: response.status >= 500,
          details: { correlationId: responseCorrelationId, method, path: new URL(url).pathname, cadError: payload?.error || payload?.code || null, body: payload, payload },
        },
      );
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new DispatcherV3Error(
        V3_ERROR_CODES.CAD_REJECTED,
        'Command Link returned an invalid JSON response',
        { statusCode: response.status, retryable: false, details: { correlationId: responseCorrelationId, method, path: new URL(url).pathname } },
      );
    }
    return Object.freeze({ success: true, statusCode: response.status, correlationId: responseCorrelationId, data: payload });
  }

  _shouldRetry(error, method, attempt, attempts) {
    return SAFE_RETRY_METHODS.has(method) && attempt < attempts && error instanceof DispatcherV3Error && error.retryable === true;
  }
}

export function createCommandLinkGateway(context, options = {}) {
  return new CommandLinkGateway(context, options);
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}

function extractErrorMessage(payload, status) {
  const message = payload?.message || payload?.error || payload?.details?.message;
  return message ? String(message) : `Command Link rejected the request with HTTP ${status}`;
}

function redactUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.delete('api_key');
  return parsed.toString();
}
