import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithRuntime } from '../runtimeContext.js';
import { getActiveCalls, validateDispatcherCadIntegration } from '../cadService.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function runtime(overrides = {}) {
  return {
    runtimeId: 'security-ai',
    profileId: 'security-ai',
    managed: true,
    dispatchCenterId: 'center-security',
    cadUrl: 'https://cad.example.test',
    cadApiKey: 'secret',
    ...overrides,
  };
}

describe('managed AI dispatcher CAD readiness', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.CAD_READ_RETRY_DELAY_MS = '0';
  });

  afterEach(() => {
    delete process.env.CAD_READ_RETRY_DELAY_MS;
    vi.unstubAllGlobals();
  });

  it('validates center, scopes, and the active-call endpoint before startup', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        dispatchCenter: { id: 'center-security', name: 'Security Dispatch' },
        scopes: ['*'],
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        calls: [{ call_id: 'call-1', call_number: '26-000001' }],
      }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWithRuntime(runtime(), () => validateDispatcherCadIntegration());

    expect(result).toMatchObject({ success: true, dispatchCenterId: 'center-security', activeCallCount: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetchMock.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('dispatch_center_id')).toBe('center-security');
      expect(options.headers['X-Dispatch-Center-Id']).toBe('center-security');
      expect(options.headers['X-API-Key']).toBe('secret');
    }
  });

  it('fails with the exact missing read scope instead of starting half-connected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      success: true,
      dispatchCenter: { id: 'center-security' },
      scopes: ['call.write', 'unit.read', 'unit.write', 'query.read'],
    })));

    const result = await runWithRuntime(runtime(), () => validateDispatcherCadIntegration());

    expect(result).toMatchObject({
      success: false,
      stage: 'scopes',
      failureType: 'INSUFFICIENT_SCOPE',
      missingScopes: ['call.read'],
    });
    expect(result.error).toContain('call.read');
  });

  it('fails when Command Link resolves a different dispatch center', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      success: true,
      dispatchCenter: { id: 'center-constable' },
      scopes: ['*'],
    })));

    const result = await runWithRuntime(runtime(), () => validateDispatcherCadIntegration());

    expect(result).toMatchObject({
      success: false,
      stage: 'dispatch_center',
      failureType: 'DISPATCH_CENTER_MISMATCH',
      expectedDispatchCenterId: 'center-security',
      actualDispatchCenterId: 'center-constable',
    });
  });

  it('retries transient active-call read failures and returns the live calls', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('temporary network failure'))
      .mockResolvedValueOnce(jsonResponse({ success: true, calls: [{ call_id: 'call-1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWithRuntime(runtime(), () => getActiveCalls());

    expect(result).toMatchObject({ success: true });
    expect(result.calls).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports an actual active-call authorization failure instead of an empty list', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        dispatchCenter: { id: 'center-security' },
        scopes: ['*'],
      }))
      .mockResolvedValueOnce(jsonResponse({ error: 'insufficient_scope', required: 'call.read' }, 403));
    vi.stubGlobal('fetch', fetchMock);

    const result = await runWithRuntime(runtime(), () => validateDispatcherCadIntegration());

    expect(result).toMatchObject({ success: false, stage: 'active_calls', statusCode: 403 });
    expect(result.error).toBe('insufficient_scope');
  });
});
