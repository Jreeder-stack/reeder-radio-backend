import { describe, expect, it, vi } from 'vitest';
import { V3ActionExecutor } from '../actionExecutor.js';
import { createDefaultV3ActionHandlers } from '../defaultActionHandlers.js';
import { V3_ACTIONS } from '../actionContracts.js';

const runtime = Object.freeze({
  runtimeId: 'r1',
  channelId: 'OPS1',
  dispatchCenterId: 'center-1',
  agencyId: 'agency-1',
  scopes: ['unit.read', 'unit.write', 'call.read', 'call.write'],
});

function makeIdentityService() {
  return {
    resolve: vi.fn(async (ref) => ({
      unitId: ref === 'INDIANA-1' ? 'uuid-1' : ref,
      callsign: 'INDIANA-1',
      agencyId: 'agency-1',
      dispatchCenterId: 'center-1',
    })),
  };
}

function makeGateway() {
  return {
    get: vi.fn(async (path) => {
      if (path === '/api/radio/status-check') return { success: true, units: [{ unit_id: 'INDIANA-1', status: 'en_route', zone: 'OPS1' }] };
      if (path.includes('/api/radio/v3/cad/calls/')) return { success: true, call: { call_id: 'call-1', call_notes: [{ text: 'BACKUP REQUESTED by INDIANA-1 at 100 Main St — fight' }] } };
      return { success: true };
    }),
    post: vi.fn(async () => ({ success: true })),
    patch: vi.fn(async () => ({ success: true })),
  };
}

describe('V3ActionExecutor', () => {
  it('validates before invoking a handler', async () => {
    const handler = vi.fn();
    const executor = new V3ActionExecutor({ runtimeContext: runtime, handlers: { SET_UNIT_STATUS: handler } });
    const result = await executor.execute({ action: 'SET_UNIT_STATUS', input: { unitId: 'uuid-1', status: 'responding' } });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_ACTION_INPUT');
    expect(handler).not.toHaveBeenCalled();
  });

  it('preserves correlation IDs and normalizes success', async () => {
    const executor = new V3ActionExecutor({ runtimeContext: runtime, handlers: { RADIO_CHECK: async () => ({ ok: true }) } });
    const result = await executor.execute({ action: 'RADIO_CHECK', input: {} }, { correlationId: 'corr-1' });
    expect(result).toMatchObject({ success: true, action: 'RADIO_CHECK', correlationId: 'corr-1', data: { ok: true } });
  });

  it('returns typed failure when a handler is missing', async () => {
    const executor = new V3ActionExecutor({ runtimeContext: runtime });
    const result = await executor.execute({ action: 'RADIO_CHECK', input: {} });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_ACTION');
    expect(result.error.statusCode).toBe(501);
  });
});

describe('default V3 handlers', () => {
  it('uses a resolved callsign and verifies status from an authoritative follow-up read', async () => {
    const gateway = makeGateway();
    const identities = makeIdentityService();
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: identities });
    const result = await handlers[V3_ACTIONS.SET_UNIT_STATUS]({ input: { unitId: 'uuid-1', status: 'en_route', note: null }, correlationId: 'c1' });
    expect(result).toMatchObject({ success: true, verified: true, unit: { unit_id: 'INDIANA-1', status: 'en_route' } });
    expect(identities.resolve).toHaveBeenNthCalledWith(1, 'uuid-1', { correlationId: 'c1' });
    expect(identities.resolve).toHaveBeenNthCalledWith(2, 'INDIANA-1', { correlationId: 'c1' });
    expect(gateway.post).toHaveBeenCalledWith('/api/radio/status', expect.objectContaining({ unit_id: 'INDIANA-1', status: 'en_route' }), { correlationId: 'c1' });
    expect(gateway.get).toHaveBeenCalledWith('/api/radio/status-check', { correlationId: 'c1' });
  });

  it('refuses callsign execution if the second resolution maps elsewhere', async () => {
    const gateway = makeGateway();
    const identities = {
      resolve: vi.fn()
        .mockResolvedValueOnce({ unitId: 'uuid-1', callsign: 'INDIANA-1' })
        .mockResolvedValueOnce({ unitId: 'uuid-2', callsign: 'INDIANA-1' }),
    };
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: identities });
    await expect(handlers[V3_ACTIONS.SET_UNIT_STATUS]({ input: { unitId: 'uuid-1', status: 'en_route' }, correlationId: 'c2' }))
      .rejects.toMatchObject({ code: 'UNIT_AMBIGUOUS', statusCode: 409 });
    expect(gateway.post).not.toHaveBeenCalled();
  });

  it('fails if follow-up CAD state does not match the requested status', async () => {
    const gateway = makeGateway();
    gateway.get.mockResolvedValueOnce({ success: true, units: [{ unit_id: 'INDIANA-1', status: 'off_duty' }] });
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: makeIdentityService() });

    await expect(handlers[V3_ACTIONS.SET_UNIT_STATUS]({
      input: { unitId: 'uuid-1', status: 'on_duty' },
      correlationId: 'verify-1',
    })).rejects.toMatchObject({ code: 'CAD_REJECTED', details: { expected: 'on_duty', actual: 'off_duty' } });
  });

  it('executes a dedicated backup request and verifies the CAD note when a call exists', async () => {
    const gateway = makeGateway();
    const operationalAlertService = { requestBackup: vi.fn(() => ({ requested: true, backup: { unitId: 'INDIANA-1' } })) };
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: makeIdentityService(), operationalAlertService });
    const result = await handlers[V3_ACTIONS.REQUEST_BACKUP]({
      input: { unitId: 'uuid-1', callId: 'call-1', location: '100 Main St', reason: 'fight', priority: 'urgent' },
      runtimeContext: runtime,
      correlationId: 'backup-1',
    });
    expect(result.requested).toBe(true);
    expect(operationalAlertService.requestBackup).toHaveBeenCalledWith(expect.objectContaining({ runtimeContext: runtime, correlationId: 'backup-1', callId: 'call-1', location: '100 Main St', reason: 'fight', priority: 'urgent' }));
    expect(gateway.post).toHaveBeenCalledWith('/api/radio/note', expect.any(Object), { correlationId: 'backup-1' });
    expect(result.cadNote).toMatchObject({ recorded: true, verified: true });
  });

  it('activates native emergency even if recording the CAD note fails', async () => {
    const gateway = makeGateway();
    gateway.post.mockRejectedValue(Object.assign(new Error('CAD down'), { code: 'CAD_UNAVAILABLE' }));
    const operationalAlertService = { declareEmergency: vi.fn(() => ({ activated: true, emergency: { unitId: 'INDIANA-1' } })) };
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: makeIdentityService(), operationalAlertService });
    const result = await handlers[V3_ACTIONS.DECLARE_EMERGENCY]({
      input: { unitId: 'uuid-1', callId: 'call-1', location: '100 Main St', reason: 'officer needs assistance' },
      runtimeContext: runtime,
      correlationId: 'emerg-1',
    });
    expect(result.activated).toBe(true);
    expect(operationalAlertService.declareEmergency).toHaveBeenCalled();
    expect(result.cadNote.recorded).toBe(false);
    expect(result.cadNote.error.code).toBe('CAD_UNAVAILABLE');
  });

  it('fails closed when Command Comms operational alerts are unavailable', async () => {
    const handlers = createDefaultV3ActionHandlers({ gateway: makeGateway(), unitIdentityService: makeIdentityService() });
    await expect(handlers[V3_ACTIONS.REQUEST_BACKUP]({
      input: { unitId: 'uuid-1', callId: null, location: null, reason: null, priority: 'urgent' },
      runtimeContext: runtime,
      correlationId: 'c3',
    })).rejects.toMatchObject({ code: 'CAD_UNAVAILABLE', statusCode: 503 });
  });
});
