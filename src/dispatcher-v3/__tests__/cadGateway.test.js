import { describe, expect, it, vi } from 'vitest';
import {
  buildV3RuntimeContext,
  createCommandLinkGateway,
  DispatcherV3Error,
  V3_ERROR_CODES,
} from '../index.js';

function context(overrides = {}) {
  return buildV3RuntimeContext({
    runtimeId: 'runtime-a',
    profileId: 'profile-a',
    dispatchCenterId: 'center-a',
    agencyId: 'agency-a',
    channelId: 12,
    roomKey: 'OPS__1',
    identity: 'AI-DISPATCHER:A',
    cadUrl: 'https://cad.example.test/',
    cadApiKey: 'secret-key',
    scopes: ['*'],
    ...overrides,
  });
}

function response(status, payload, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: vi.fn().mockResolvedValue(payload === undefined ? '' : JSON.stringify(payload)),
  };
}

describe('CommandLinkGateway', () => {
  it('injects auth, center, runtime and correlation context on every request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, { success: true }, { 'x-correlation-id': 'cad-123' }));
    const gateway = createCommandLinkGateway(context(), { fetchImpl, maxSafeRetries: 0 });

    const result = await gateway.request('/api/radio/integration-context', {
      correlationId: 'turn-123',
      query: { foo: 'bar' },
    });

    expect(result.correlationId).toBe('cad-123');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, options] = fetchImpl.mock.calls[0];
    const parsed = new URL(url);
    expect(parsed.searchParams.get('dispatch_center_id')).toBe('center-a');
    expect(parsed.searchParams.get('foo')).toBe('bar');
    expect(options.headers.get('X-API-Key')).toBe('secret-key');
    expect(options.headers.get('X-Dispatch-Center-Id')).toBe('center-a');
    expect(options.headers.get('X-Agency-Id')).toBe('agency-a');
    expect(options.headers.get('X-Dispatcher-Runtime-Id')).toBe('runtime-a');
    expect(options.headers.get('X-Correlation-Id')).toBe('turn-123');
  });

  it('serializes object bodies and does not retry unsafe writes', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const gateway = createCommandLinkGateway(context(), { fetchImpl, maxSafeRetries: 5 });

    await expect(gateway.request('/api/radio/status', {
      method: 'POST',
      body: { unit_id: 'INDIANA-1', status: 'on duty' },
    })).rejects.toMatchObject({ code: V3_ERROR_CODES.CAD_UNAVAILABLE, retryable: true });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, options] = fetchImpl.mock.calls[0];
    expect(options.headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({ unit_id: 'INDIANA-1', status: 'on duty' });
  });

  it('retries a transient safe read once', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(response(200, { success: true }));
    const gateway = createCommandLinkGateway(context(), { fetchImpl, maxSafeRetries: 1 });

    const result = await gateway.request('/api/radio/calls');
    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('normalizes CAD HTTP errors without reporting success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(409, {
      success: false,
      error: 'external_unit_not_in_dispatch_center',
      message: 'Unit belongs to another center',
    }));
    const gateway = createCommandLinkGateway(context(), { fetchImpl, maxSafeRetries: 0 });

    await expect(gateway.request('/api/radio/status', { method: 'POST', body: {} }))
      .rejects.toMatchObject({
        code: V3_ERROR_CODES.CAD_REJECTED,
        statusCode: 409,
        message: 'Unit belongs to another center',
      });
  });

  it('rejects invalid non-object JSON success responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: vi.fn().mockResolvedValue('[]'),
    });
    const gateway = createCommandLinkGateway(context(), { fetchImpl, maxSafeRetries: 0 });

    await expect(gateway.request('/api/radio/calls')).rejects.toBeInstanceOf(DispatcherV3Error);
  });

  it('rejects paths that are not absolute API paths', async () => {
    const gateway = createCommandLinkGateway(context(), { fetchImpl: vi.fn() });
    await expect(gateway.request('api/radio/calls')).rejects.toMatchObject({
      code: V3_ERROR_CODES.INVALID_ACTION_INPUT,
    });
  });
});
