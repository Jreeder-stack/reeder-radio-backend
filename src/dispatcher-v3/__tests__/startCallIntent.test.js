import { describe, expect, it, vi } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';
import { V3IntentPlanner } from '../intentPlanner.js';

const speakerCallsign = 'INDIANA-1';
const location = '58 Cripps St, Blairsville PA';

// Free-form calls use the retained semantic boundary. Synthetic model replies
// verify routing and plan preservation; real language quality is a provider gate.
async function interpret(transcript, reply) {
  expect(planDeterministicV3Intent({ transcript, speakerCallsign })).toBeNull();
  const create = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify({ confidence: 1, ...reply }) } }] }));
  const planner = new V3IntentPlanner({ client: { chat: { completions: { create } } } });
  const result = await planner.plan({ transcript, speakerCallsign });
  expect(create).toHaveBeenCalledTimes(1);
  expect(JSON.parse(create.mock.calls[0][0].messages[1].content)).toMatchObject({ transcript, speakerCallsign });
  return result;
}

describe('Dispatcher V3 start-call semantic routing', () => {
  it('preserves a semantically interpreted warrant service with assignment', async () => {
    const expected = { action: 'CREATE_CALL', input: { type: 'WARRANT SERVICE', location, unitRefs: [speakerCallsign] } };
    expect(await interpret(`start a warrant service at ${location}`, expected)).toMatchObject({ ...expected, confidence: 1 });
  });

  it('preserves create, assignment and en-route operations for self-initiated service', async () => {
    const actions = [
      { action: 'CREATE_CALL', input: { type: 'WARRANT SERVICE', location, unitRefs: [speakerCallsign] } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: speakerCallsign, status: 'en_route' } },
    ];
    expect(await interpret(`show me en route to a warrant service at ${location}`, { actions }))
      .toMatchObject({ action: 'MULTI_ACTION', confidence: 1, actions });
  });

  it('preserves other self-initiated call natures through the same semantic path', async () => {
    const actions = [
      { action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main St, Indiana PA', unitRefs: [speakerCallsign] } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: speakerCallsign, status: 'en_route' } },
    ];
    expect(await interpret('responding to a building check at 100 Main St, Indiana PA', { actions }))
      .toMatchObject({ action: 'MULTI_ACTION', actions });
  });

  it('does not hardcode the call nature or consume additional instructions as location', async () => {
    const expected = { action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main St, Indiana PA', unitRefs: [speakerCallsign] } };
    expect(await interpret('start a building check at 100 Main St, Indiana PA', expected)).toMatchObject(expected);
  });

  it('preserves the explicit no-assignment request through semantic interpretation', async () => {
    const expected = { action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main St, Indiana PA' } };
    const result = await interpret("create a building check at 100 Main St, Indiana PA, don't assign anybody", expected);
    expect(result).toMatchObject(expected);
    expect(result.input.unitRefs).toBeUndefined();
  });
});
