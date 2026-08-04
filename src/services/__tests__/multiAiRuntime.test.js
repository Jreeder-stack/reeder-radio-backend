import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRuntimeScopedMap, runWithRuntime } from '../runtimeContext.js';
import { buildWsUrl, CadStatusCheckClient } from '../cadStatusCheckClient.js';

vi.mock('../cadService.js', async (importOriginal) => {
  const actual = await importOriginal();
  return actual;
});

function managedStatusCheckClient() {
  return new CadStatusCheckClient({
    runtimeId: 'security-ai',
    profileId: 'security-ai',
    managed: true,
    dispatchCenterId: 'center-security',
    cadUrl: 'https://cad.example.test',
    cadApiKey: 'secret',
  });
}

function dueEvent(overrides = {}) {
  return {
    type: 'status_check_due',
    dispatchCenterId: 'center-security',
    data: {
      assignmentId: 'assignment-1',
      callId: 'call-security-1',
      unitId: 'cad-user-2301',
      unitNumber: '2301',
      dueAt: new Date(Date.now() - 1000).toISOString(),
      ...overrides,
    },
  };
}

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

  it('drops call-less prompts for managed multi-center dispatchers', async () => {
    const client = managedStatusCheckClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn();

    await client._handleEvent(dueEvent({ callId: null, assignmentId: null }));

    expect(handler).not.toHaveBeenCalled();
    expect(client._runCad).not.toHaveBeenCalled();
  });

  it('drops an event when the callsign is not active on that exact call in the selected center', async () => {
    const client = managedStatusCheckClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn().mockResolvedValueOnce({
      has_active_call: true,
      call_id: 'different-call',
    });

    await client._handleEvent(dueEvent());

    expect(handler).not.toHaveBeenCalled();
    expect(client._runCad).toHaveBeenCalledTimes(1);
  });

  it('drops a stale event when the exact pending assignment no longer exists', async () => {
    const client = managedStatusCheckClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn()
      .mockResolvedValueOnce({ has_active_call: true, call_id: 'call-security-1' })
      .mockResolvedValueOnce({
        success: true,
        pending_checks: [{
          id: 'other-assignment',
          call_id: 'call-security-1',
          unit_id: 'cad-user-2301',
          unit_number: '2301',
          state: 'pending',
        }],
      });

    await client._handleEvent(dueEvent());

    expect(handler).not.toHaveBeenCalled();
    expect(client._runCad).toHaveBeenCalledTimes(2);
  });

  it('accepts only an exact center, call, assignment, CAD user, and callsign match', async () => {
    const client = managedStatusCheckClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn()
      .mockResolvedValueOnce({ has_active_call: true, call_id: 'call-security-1' })
      .mockResolvedValueOnce({
        success: true,
        pending_checks: [{
          id: 'assignment-1',
          call_id: 'call-security-1',
          unit_id: 'cad-user-2301',
          unit_number: '2301',
          state: 'pending',
        }],
      });

    await client._handleEvent(dueEvent());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'status_check_due',
      unitId: 'cad-user-2301',
      unitNumber: '2301',
      callId: 'call-security-1',
    }));
  });

  it('drops a WebSocket event explicitly scoped to another dispatch center', async () => {
    const client = managedStatusCheckClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn();

    const event = dueEvent();
    event.dispatchCenterId = 'center-constable';
    await client._handleEvent(event);

    expect(handler).not.toHaveBeenCalled();
    expect(client._runCad).not.toHaveBeenCalled();
  });

  it('still accepts terminal events so an existing local prompt can be cleared', async () => {
    const client = managedStatusCheckClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn();

    await client._handleEvent({
      type: 'status_check_cancelled',
      dispatchCenterId: 'center-security',
      data: {
        assignmentId: 'assignment-1',
        callId: 'call-security-1',
        unitId: 'cad-user-2301',
        unitNumber: '2301',
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(client._runCad).not.toHaveBeenCalled();
  });
});