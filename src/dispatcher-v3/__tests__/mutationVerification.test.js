import { describe, expect, it, vi } from 'vitest';
import { createDefaultV3ActionHandlers } from '../defaultActionHandlers.js';
import { V3_ACTIONS } from '../actionContracts.js';

function identities() {
  return {
    resolve: vi.fn(async (ref) => {
      const value = String(ref).toUpperCase();
      if (value === 'U1' || value === '101') return { unitId: 'U1', callsign: '101' };
      if (value === 'U2' || value === '102') return { unitId: 'U2', callsign: '102' };
      throw new Error(`unknown ${ref}`);
    }),
  };
}

function handlers(gateway) {
  return createDefaultV3ActionHandlers({ gateway, unitIdentityService: identities() });
}

describe('Step 5 CAD mutation read-back', () => {
  it('verifies unit zone from status catalog after the write', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, units: [{ unit_id: '101', zone: 'ZONE 2', status: 'available' }] })),
      patch: vi.fn(),
    };
    const result = await handlers(gateway)[V3_ACTIONS.CHANGE_UNIT_ZONE]({ input: { unitId: 'U1', zone: 'Zone 2' }, correlationId: 'zone-1' });
    expect(result.verified).toBe(true);
  });

  it('rejects a zone write when follow-up state is stale', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, units: [{ unit_id: '101', zone: 'ZONE 1' }] })),
      patch: vi.fn(),
    };
    await expect(handlers(gateway)[V3_ACTIONS.CHANGE_UNIT_ZONE]({ input: { unitId: 'U1', zone: 'ZONE 2' }, correlationId: 'zone-bad' }))
      .rejects.toMatchObject({ code: 'CAD_REJECTED' });
  });

  it('verifies a newly assigned unit is present on the call', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, call: { call_id: 'C1', assigned_units: [{ unit_id: 'U1', callsign: '101' }] } })),
      patch: vi.fn(),
    };
    const result = await handlers(gateway)[V3_ACTIONS.ASSIGN_UNIT]({ input: { callId: 'C1', unitId: 'U1' }, correlationId: 'assign-1' });
    expect(result.verified).toBe(true);
  });

  it('rejects assignment success when the unit never appears on the call', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, call: { call_id: 'C1', assigned_units: [] } })),
      patch: vi.fn(),
    };
    await expect(handlers(gateway)[V3_ACTIONS.ASSIGN_UNIT]({ input: { callId: 'C1', unitId: 'U1' }, correlationId: 'assign-bad' }))
      .rejects.toMatchObject({ code: 'CAD_REJECTED' });
  });

  it('verifies primary unit after the primary write', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, call: { call_id: 'C1', primary_unit: { unit_id: 'U2', callsign: '102' }, assigned_units: [{ unit_id: 'U2', callsign: '102' }] } })),
      patch: vi.fn(),
    };
    const result = await handlers(gateway)[V3_ACTIONS.MAKE_PRIMARY]({ input: { callId: 'C1', unitId: 'U2' }, correlationId: 'primary-1' });
    expect(result.verified).toBe(true);
  });

  it('verifies call notes after legacy note creation', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, call: { call_id: 'C1', call_notes: [{ text: 'SUSPECT IN REAR YARD' }] } })),
      patch: vi.fn(),
    };
    const result = await handlers(gateway)[V3_ACTIONS.ADD_CALL_NOTE]({ input: { callId: 'C1', note: 'SUSPECT IN REAR YARD', unitId: null }, correlationId: 'note-1' });
    expect(result.verified).toBe(true);
  });

  it('verifies terminal status and disposition after closing a call', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, call: { call_id: 'C1', status: 'closed', disposition: 'COMPLETE', assigned_units: [] } })),
      patch: vi.fn(),
    };
    const result = await handlers(gateway)[V3_ACTIONS.CLOSE_CALL]({ input: { callId: 'C1', disposition: 'COMPLETE', unitIds: [], note: null }, correlationId: 'close-1' });
    expect(result.verified).toBe(true);
  });

  it('rejects call closure when CAD still reports an active call', async () => {
    const gateway = {
      post: vi.fn(async () => ({ success: true })),
      get: vi.fn(async () => ({ success: true, call: { call_id: 'C1', status: 'active', disposition: null } })),
      patch: vi.fn(),
    };
    await expect(handlers(gateway)[V3_ACTIONS.CLOSE_CALL]({ input: { callId: 'C1', disposition: 'COMPLETE', unitIds: [], note: null }, correlationId: 'close-bad' }))
      .rejects.toMatchObject({ code: 'CAD_REJECTED' });
  });
});
