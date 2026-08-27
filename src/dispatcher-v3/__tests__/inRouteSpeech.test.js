import { describe, expect, it } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';

describe('Dispatcher V3 in-route speech normalization', () => {
  it('treats speech-to-text in route as en route for self-initiated calls', () => {
    const plan = planDeterministicV3Intent({
      transcript: 'show me in route to a warrant service at 58 Cripps St, Blairsville PA',
      speakerCallsign: 'INDIANA-1',
    });

    expect(plan.action).toBe('MULTI_ACTION');
    expect(plan.reason).toBe('deterministic_self_initiated_response');
    expect(plan.actions).toEqual([
      {
        action: 'CREATE_CALL',
        input: {
          type: 'WARRANT SERVICE',
          location: '58 Cripps St, Blairsville PA',
          unitRefs: ['INDIANA-1'],
        },
      },
      {
        action: 'SET_UNIT_STATUS',
        input: { unitRef: 'INDIANA-1', status: 'en_route' },
      },
    ]);
  });

  it('normalizes a simple in-route status request too', () => {
    const plan = planDeterministicV3Intent({
      transcript: 'show me in route',
      speakerCallsign: 'INDIANA-1',
    });
    expect(plan.action).toBe('SET_UNIT_STATUS');
    expect(plan.input.status).toBe('en_route');
  });
});
