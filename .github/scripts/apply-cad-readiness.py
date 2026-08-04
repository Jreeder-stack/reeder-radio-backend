from pathlib import Path

cad_path = Path('src/services/cadService.js')
cad = cad_path.read_text()
old = """export async function getActiveCalls(status = null) {
  const endpoint = status ? `/api/radio/calls?status=${status}` : '/api/radio/calls';
  return cadRequest(endpoint, 'GET');
}
"""
new = """const DEFAULT_CAD_READ_RETRIES = 3;
const DEFAULT_CAD_READ_RETRY_DELAY_MS = 150;
export const CORE_AI_DISPATCHER_CAD_SCOPES = Object.freeze([
  'call.read',
  'call.write',
  'unit.read',
  'unit.write',
  'query.read',
]);

function getCadReadRetryDelayMs() {
  const configured = Number.parseInt(process.env.CAD_READ_RETRY_DELAY_MS || '', 10);
  if (Number.isFinite(configured) && configured >= 0 && configured <= 5000) return configured;
  return DEFAULT_CAD_READ_RETRY_DELAY_MS;
}

function isRetryableCadReadFailure(result) {
  if (!result || result.success !== false) return false;
  if (result.failureType === 'UNREACHABLE') return true;
  const statusCode = Number(result.statusCode);
  return Number.isFinite(statusCode) && statusCode >= 500;
}

async function cadGetWithRetry(endpoint, attempts = DEFAULT_CAD_READ_RETRIES) {
  const maxAttempts = Math.max(1, Number.parseInt(attempts, 10) || DEFAULT_CAD_READ_RETRIES);
  let result = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    result = await cadRequest(endpoint, 'GET');
    if (!isRetryableCadReadFailure(result) || attempt >= maxAttempts) return result;
    const delayMs = getCadReadRetryDelayMs() * attempt;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return result;
}

export async function getActiveCalls(status = null) {
  const endpoint = status ? `/api/radio/calls?status=${status}` : '/api/radio/calls';
  return cadGetWithRetry(endpoint);
}

export async function validateDispatcherCadIntegration({ requiredScopes = CORE_AI_DISPATCHER_CAD_SCOPES } = {}) {
  const { runtime, dispatchCenterId } = getCadRuntimeConfig();
  const expectedCenterId = String(dispatchCenterId || '').trim();

  const integration = await cadGetWithRetry('/api/radio/integration-context');
  if (!integration || integration.success === false) {
    return {
      success: false,
      stage: 'integration_context',
      error: integration?.error || 'Unable to read Command Link integration context',
      failureType: integration?.failureType || 'CAD_PREFLIGHT_FAILED',
      statusCode: integration?.statusCode ?? null,
      responseBody: integration?.responseBody ?? null,
    };
  }

  const actualCenterId = String(integration?.dispatchCenter?.id || '').trim();
  if (runtime.managed && (!expectedCenterId || !actualCenterId || actualCenterId !== expectedCenterId)) {
    return {
      success: false,
      stage: 'dispatch_center',
      error: `Command Link dispatch center mismatch: expected ${expectedCenterId || 'none'}, received ${actualCenterId || 'none'}`,
      failureType: 'DISPATCH_CENTER_MISMATCH',
      statusCode: 409,
      expectedDispatchCenterId: expectedCenterId || null,
      actualDispatchCenterId: actualCenterId || null,
    };
  }

  const scopes = Array.isArray(integration.scopes)
    ? integration.scopes.map(scope => String(scope))
    : [];
  const requestedScopes = Array.from(new Set(
    (Array.isArray(requiredScopes) ? requiredScopes : CORE_AI_DISPATCHER_CAD_SCOPES)
      .map(scope => String(scope || '').trim())
      .filter(Boolean)
  ));
  const missingScopes = scopes.includes('*')
    ? []
    : requestedScopes.filter(scope => !scopes.includes(scope));
  if (missingScopes.length > 0) {
    return {
      success: false,
      stage: 'scopes',
      error: `Command Link API key is missing required scope${missingScopes.length === 1 ? '' : 's'}: ${missingScopes.join(', ')}`,
      failureType: 'INSUFFICIENT_SCOPE',
      statusCode: 403,
      scopes,
      missingScopes,
    };
  }

  const activeCalls = await getActiveCalls();
  if (!activeCalls || activeCalls.success === false) {
    return {
      success: false,
      stage: 'active_calls',
      error: activeCalls?.error || 'Unable to read active calls from Command Link',
      failureType: activeCalls?.failureType || 'CAD_PREFLIGHT_FAILED',
      statusCode: activeCalls?.statusCode ?? null,
      responseBody: activeCalls?.responseBody ?? null,
    };
  }
  if (!Array.isArray(activeCalls.calls)) {
    return {
      success: false,
      stage: 'active_calls',
      error: 'Command Link returned a malformed active-call response',
      failureType: 'MALFORMED_RESPONSE',
      statusCode: 502,
    };
  }

  return {
    success: true,
    dispatchCenterId: actualCenterId || expectedCenterId || null,
    dispatchCenterName: integration?.dispatchCenter?.name || null,
    scopes,
    activeCallCount: activeCalls.calls.length,
  };
}
"""
assert cad.count(old) == 1, f'getActiveCalls block changed unexpectedly: {cad.count(old)} matches'
cad_path.write_text(cad.replace(old, new, 1))

manager_path = Path('src/services/aiDispatcherRuntimeManager.js')
manager = manager_path.read_text()
old_import = "import { bindRuntime, runWithRuntime } from './runtimeContext.js';"
new_import = old_import + "\nimport { CORE_AI_DISPATCHER_CAD_SCOPES, validateDispatcherCadIntegration } from './cadService.js';"
assert manager.count(old_import) == 1, f'runtime import changed unexpectedly: {manager.count(old_import)} matches'
manager = manager.replace(old_import, new_import, 1)
old_start = """      const runtime = await runWithRuntime(context, async () => {
        const dispatcher = new AIDispatcher({
"""
new_start = """      const runtime = await runWithRuntime(context, async () => {
        const requiredCadScopes = [
          ...CORE_AI_DISPATCHER_CAD_SCOPES,
          ...(profile.status_checks_enabled !== false
            ? ['status_check.read', 'status_check.write']
            : []),
        ];
        const cadPreflight = await validateDispatcherCadIntegration({ requiredScopes: requiredCadScopes });
        if (!cadPreflight.success) {
          const error = new Error(`CAD readiness check failed at ${cadPreflight.stage || 'unknown'}: ${cadPreflight.error || 'unknown error'}`);
          error.statusCode = cadPreflight.statusCode || 503;
          error.cadPreflight = cadPreflight;
          throw error;
        }
        this.log('CAD_PREFLIGHT_OK', {
          id: profile.id,
          dispatchCenterId: cadPreflight.dispatchCenterId,
          activeCallCount: cadPreflight.activeCallCount,
          scopes: cadPreflight.scopes,
        });

        const dispatcher = new AIDispatcher({
"""
assert manager.count(old_start) == 1, f'startProfile runtime block changed unexpectedly: {manager.count(old_start)} matches'
manager_path.write_text(manager.replace(old_start, new_start, 1))

test_path = Path('src/services/__tests__/cadIntegrationPreflight.test.js')
test_path.write_text(r'''import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
''')
