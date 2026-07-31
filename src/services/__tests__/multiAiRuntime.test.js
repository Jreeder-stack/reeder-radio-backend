import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRuntimeScopedMap, runWithRuntime } from '../runtimeContext.js';
import { buildWsUrl } from '../cadStatusCheckClient.js';

vi.mock('../cadService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

describe('multi AI dispatcher runtime isolation', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('isolates identical unit keys between dispatcher runtimes', async () => {
    const map = createRuntimeScopedMap();
    await runWithRuntime({ runtimeId: 'constable' }, async () => map.set('UNIT-1', { state: 'CONSTABLE' }));
    await runWithRuntime({ runtimeId: 'security' }, async () => map.set('UNIT-1', { state: 'SECURITY' }));
    expect(await runWithRuntime({ runtimeId: 'constable' }, async () => map.get('UNIT-1').state)).toBe('CONSTABLE');
    expect(await runWithRuntime({ runtimeId: 'security' }, async () => map.get('UNIT-1').state)).toBe('SECURITY');
  });

  it('builds a center-scoped status-check websocket URL', () => {
    const url = new URL(buildWsUrl({
      cadUrl: 'https://cad.example.test',
      cadApiKey: 'secret',
      dispatchCenterId: 'center-security',
      agencyId: 'agency-security',
    }));
    expect(url.protocol).toBe('wss:');
    expect(url.searchParams.get('api_key')).toBe('secret');
    expect(url.searchParams.get('dispatch_center_id')).toBe('center-security');
    expect(url.searchParams.get('agency_id')).toBe('agency-security');
  });

  it('refuses to build an unscoped managed websocket', () => {
    expect(buildWsUrl({ cadUrl: 'https://cad.example.test', cadApiKey: 'secret' })).toBeNull();
  });
});
