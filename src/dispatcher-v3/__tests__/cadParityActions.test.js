import { describe, expect, it, vi } from 'vitest';
import { V3_ACTIONS, validateV3ActionRequest } from '../actionContracts.js';
import { createDefaultV3ActionHandlers } from '../defaultActionHandlers.js';
import { materializeV3Plan } from '../planMaterializer.js';

const runtimeContext = {
  runtimeId: 'rt-1', dispatchCenterId: 'dc-1', channelId: 'ch-1', roomKey: 'ops',
  cadUrl: 'https://cad.example', cadApiKey: 'key',
  scopes: ['call.read', 'call.write', 'unit.read', 'unit.write'],
};

function identityService() {
  return {
    resolve: vi.fn(async (ref) => {
      const value = String(ref).toUpperCase();
      if (value === 'U1' || value === '101') return { unitId: 'U1', callsign: '101' };
      if (value === 'U2' || value === '102') return { unitId: 'U2', callsign: '102' };
      throw new Error(`unknown unit ${ref}`);
    }),
  };
}

describe('Dispatcher V3 CAD parity actions', () => {
  it('allows creating a call with no assigned units', () => {
    const validated = validateV3ActionRequest({
      action: V3_ACTIONS.CREATE_CALL,
      input: { type: 'BUILDING CHECK', location: '100 MAIN ST' },
    }, runtimeContext);
    expect(validated.input.unitIds).toEqual([]);
  });

  it('materializes natural call and unit references for primary changes', async () => {
    const units = identityService();
    const calls = { resolveCallId: vi.fn(async () => 'CALL-1') };
    const plan = await materializeV3Plan({ action: V3_ACTIONS.MAKE_PRIMARY, input: { callRef: 'that call', unitRef: '102' } }, {
      speakerCallsign: '101', unitIdentityService: units, operationalContextService: calls,
      operationalContext: {}, correlationId: 'corr-1',
    });
    expect(plan.input).toEqual({ callId: 'CALL-1', unitId: 'U2' });
  });

  it('routes structured call updates through the parity API', async () => {
    const gateway = { get: vi.fn(), post: vi.fn(), patch: vi.fn(async () => ({ success: true, call: { call_id: 'CALL-1', caller_name: 'SMITH' } })) };
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: identityService() });
    const result = await handlers[V3_ACTIONS.UPDATE_CALL]({ input: {
      callId: 'CALL-1', type: null, location: null, apt: null, city: null, state: null, zip: null,
      county: null, municipality: null, zone: null, latitude: null, longitude: null, crossStreet1: null,
      crossStreet2: null, priority: null, status: null, description: null, callerName: 'SMITH', callerPhone: '5551212',
      locationAddressId: null, securityClientId: null, securityClientSiteId: null, disposition: null, dispositionNotes: null,
    }, correlationId: 'corr-2' });
    expect(gateway.patch).toHaveBeenCalledWith('/api/radio/v3/cad/calls/CALL-1', {
      caller_name: 'SMITH', callback_number: '5551212',
    }, { correlationId: 'corr-2' });
    expect(result.call.call_id).toBe('CALL-1');
  });

  it('uses explicit unassign without invoking legacy clear/dispose', async () => {
    const gateway = { get: vi.fn(), patch: vi.fn(), post: vi.fn(async () => ({ success: true })) };
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: identityService() });
    await handlers[V3_ACTIONS.UNASSIGN_UNIT]({ input: { callId: 'CALL-1', unitId: 'U1' }, correlationId: 'corr-3' });
    expect(gateway.post).toHaveBeenCalledWith('/api/radio/v3/cad/calls/CALL-1/unassign-unit', { unit_id: '101' }, { correlationId: 'corr-3' });
  });

  it('sends assignment time corrections with a safely resolved callsign', async () => {
    const gateway = { get: vi.fn(), post: vi.fn(), patch: vi.fn(async () => ({ success: true })) };
    const handlers = createDefaultV3ActionHandlers({ gateway, unitIdentityService: identityService() });
    await handlers[V3_ACTIONS.UPDATE_ASSIGNMENT_TIMES]({ input: {
      callId: 'CALL-1', unitId: 'U1', assignedAt: null, dispatchedAt: null, arrivedAt: '2026-08-08T14:32:00-04:00', ondtAt: null,
    }, correlationId: 'corr-4' });
    expect(gateway.patch).toHaveBeenCalledWith('/api/radio/v3/cad/calls/CALL-1/assignment-times', {
      unit_id: '101', assigned_at: undefined, dispatched_at: undefined, arrived_at: '2026-08-08T14:32:00-04:00', ondt_at: undefined,
    }, { correlationId: 'corr-4' });
  });
});
