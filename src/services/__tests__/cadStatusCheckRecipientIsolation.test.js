import { describe, expect, it, vi } from 'vitest';
import { CadStatusCheckClient } from '../cadStatusCheckClient.js';

function managedClient() {
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

describe('CAD status-check recipient isolation', () => {
  it('drops call-less prompts for managed multi-center dispatchers', async () => {
    const client = managedClient();
    const handler = vi.fn();
    client.handler = handler;
    client._runCad = vi.fn();

    await client._handleEvent(dueEvent({ callId: null, assignmentId: null }));

    expect(handler).not.toHaveBeenCalled();
    expect(client._runCad).not.toHaveBeenCalled();
  });

  it('drops an event when the callsign is not active on that exact call in the selected center', async () => {
    const client = managedClient();
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
    const client = managedClient();
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
    const client = managedClient();
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
    const client = managedClient();
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
    const client = managedClient();
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
