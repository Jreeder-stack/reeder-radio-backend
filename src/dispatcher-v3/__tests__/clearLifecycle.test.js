import { describe, expect, it, vi } from 'vitest';
import { createDefaultV3ActionHandlers } from '../defaultActionHandlers.js';
import { V3_ACTIONS } from '../actionContracts.js';
import { planDeterministicV3Intent } from '../deterministicIntent.js';

function makeHandlers(initialCallPayload, verifiedCall) {
  const gateway = {
    get: vi.fn(async (path) => {
      if (path.startsWith('/api/radio/call/')) return initialCallPayload;
      if (path.startsWith('/api/radio/v3/cad/calls/')) return { success: true, call: verifiedCall };
      return { success: true };
    }),
    post: vi.fn(async (path, body) => ({ success: true, path, body })),
  };
  const unitIdentityService = {
    resolve: vi.fn(async () => ({ unitId: 'unit-1', callsign: 'INDIANA-1', status: 'on_scene' })),
  };
  return { handlers: createDefaultV3ActionHandlers({ gateway, unitIdentityService }), gateway };
}

describe('Dispatcher V3 clear lifecycle', () => {
  it.each([
    "I'm clear of the call I was on",
    'clear me from the call',
    'show me clear of my call',
  ])('treats clear-of-call speech as CLEAR_UNIT: %s', (transcript) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign: 'INDIANA-1' })).toMatchObject({
      action: V3_ACTIONS.CLEAR_UNIT,
      input: { unitRef: 'INDIANA-1' },
      confidence: 1,
    });
  });

  it('requires a disposition before mutating the only active assignment', async () => {
    const { handlers, gateway } = makeHandlers({
      success: true,
      call: { id: 'call-1', assignments: [{ unit_id: 'unit-1', unit_number: 'INDIANA-1', active: true }] },
    }, {
      call_id: 'call-1', status: 'assigned', assigned_units: [{ unit_id: 'unit-1', callsign: 'INDIANA-1' }],
    });

    await expect(handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1' }, correlationId: 'corr-1' }))
      .rejects.toMatchObject({ code: 'DISPOSITION_REQUIRED', details: { callId: 'call-1' } });

    expect(gateway.post).not.toHaveBeenCalled();
  });

  it('fails safe and asks for a disposition when assignment details are unavailable', async () => {
    const { handlers, gateway } = makeHandlers({ success: true, call: { id: 'call-1' } }, {
      call_id: 'call-1', status: 'assigned', assigned_units: [{ unit_id: 'unit-1', callsign: 'INDIANA-1' }],
    });

    await expect(handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1' }, correlationId: 'corr-unknown' }))
      .rejects.toMatchObject({ code: 'DISPOSITION_REQUIRED' });

    expect(gateway.post).not.toHaveBeenCalled();
  });

  it('disposes the call after the only active unit supplies a disposition', async () => {
    const { handlers, gateway } = makeHandlers({
      success: true,
      call: { id: 'call-1', assignments: [{ unit_id: 'unit-1', unit_number: 'INDIANA-1', active: true }] },
    }, {
      call_id: 'call-1', status: 'closed', disposition: 'ARREST', assigned_units: [],
    });

    const result = await handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1', disposition: 'ARREST' }, correlationId: 'corr-1' });

    expect(gateway.post).toHaveBeenCalledWith('/api/radio/dispose', {
      call_id: 'call-1', disposition: 'ARREST', unit_ids: ['INDIANA-1'],
    }, { correlationId: 'corr-1' });
    expect(gateway.post).not.toHaveBeenCalledWith('/api/radio/clear', expect.anything(), expect.anything());
    expect(result.verified).toBe(true);
  });

  it('clears only the unit when other active assignments remain and verifies the target is absent', async () => {
    const { handlers, gateway } = makeHandlers({
      success: true,
      call: {
        id: 'call-1',
        assignments: [
          { unit_id: 'unit-1', unit_number: 'INDIANA-1', active: true },
          { unit_id: 'unit-2', unit_number: 'INDIANA-2', active: true },
        ],
      },
    }, {
      call_id: 'call-1', status: 'assigned', assigned_units: [{ unit_id: 'unit-2', callsign: 'INDIANA-2' }],
    });

    const result = await handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1' }, correlationId: 'corr-1' });

    expect(gateway.post).toHaveBeenCalledWith('/api/radio/clear', {
      call_id: 'call-1', unit_id: 'INDIANA-1', disposition: undefined,
    }, { correlationId: 'corr-1' });
    expect(gateway.post).not.toHaveBeenCalledWith('/api/radio/dispose', expect.anything(), expect.anything());
    expect(result.verified).toBe(true);
  });

  it('rejects a clear acknowledgment when CAD still shows the unit assigned', async () => {
    const { handlers } = makeHandlers({
      success: true,
      call: { id: 'call-1', assignments: [{ unit_id: 'unit-1', unit_number: 'INDIANA-1', active: true }, { unit_id: 'unit-2', active: true }] },
    }, {
      call_id: 'call-1', status: 'assigned', assigned_units: [{ unit_id: 'unit-1', callsign: 'INDIANA-1' }, { unit_id: 'unit-2' }],
    });

    await expect(handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1' }, correlationId: 'corr-bad' }))
      .rejects.toMatchObject({ code: 'CAD_REJECTED' });
  });
});
