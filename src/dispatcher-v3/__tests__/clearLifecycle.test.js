import { describe, expect, it, vi } from 'vitest';
import { createDefaultV3ActionHandlers } from '../defaultActionHandlers.js';
import { V3_ACTIONS } from '../actionContracts.js';
import { planDeterministicV3Intent } from '../deterministicIntent.js';

function makeHandlers(callPayload) {
  const gateway = {
    get: vi.fn(async () => callPayload),
    post: vi.fn(async (path, body) => ({ success: true, path, body })),
  };
  const unitIdentityService = {
    resolve: vi.fn(async (ref) => ({ unitId: 'unit-1', callsign: 'INDIANA-1', status: 'on_scene' })),
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

  it('disposes the call when the clearing unit is the only active assignment', async () => {
    const { handlers, gateway } = makeHandlers({
      success: true,
      call: { id: 'call-1', assignments: [{ unit_id: 'unit-1', unit_number: 'INDIANA-1', active: true }] },
    });

    await handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1' }, correlationId: 'corr-1' });

    expect(gateway.post).toHaveBeenCalledWith('/api/radio/dispose', {
      call_id: 'call-1', disposition: 'CLEARED', unit_ids: ['INDIANA-1'],
    }, { correlationId: 'corr-1' });
    expect(gateway.post).not.toHaveBeenCalledWith('/api/radio/clear', expect.anything(), expect.anything());
  });

  it('clears only the unit when other active assignments remain', async () => {
    const { handlers, gateway } = makeHandlers({
      success: true,
      call: {
        id: 'call-1',
        assignments: [
          { unit_id: 'unit-1', unit_number: 'INDIANA-1', active: true },
          { unit_id: 'unit-2', unit_number: 'INDIANA-2', active: true },
        ],
      },
    });

    await handlers[V3_ACTIONS.CLEAR_UNIT]({ input: { callId: 'call-1', unitId: 'unit-1' }, correlationId: 'corr-1' });

    expect(gateway.post).toHaveBeenCalledWith('/api/radio/clear', {
      call_id: 'call-1', unit_id: 'INDIANA-1', disposition: undefined,
    }, { correlationId: 'corr-1' });
    expect(gateway.post).not.toHaveBeenCalledWith('/api/radio/dispose', expect.anything(), expect.anything());
  });
});
