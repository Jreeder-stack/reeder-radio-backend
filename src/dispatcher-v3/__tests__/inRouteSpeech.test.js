import { describe, expect, it, vi } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';
import { V3IntentPlanner } from '../intentPlanner.js';

describe('Dispatcher V3 in-route speech normalization', () => {
  it('preserves in-route wording for semantic interpretation of a self-initiated call', async () => {
    const request = {
      transcript: 'show me in route to a warrant service at 58 Cripps St, Blairsville PA',
      speakerCallsign: 'INDIANA-1',
    };
    expect(planDeterministicV3Intent(request)).toBeNull();
    const actions = [
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
    ];
    const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ confidence: 1, actions }) } }] }));
    const planner = new V3IntentPlanner({ client: { chat: { completions: { create } } } });
    const plan = await planner.plan(request);
    expect(plan).toMatchObject({ action: 'MULTI_ACTION', actions });
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(create.mock.calls[0][0].messages[1].content).transcript).toBe(request.transcript);
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
