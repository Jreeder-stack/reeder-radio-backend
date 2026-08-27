import { describe, expect, it } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';
import { V3_ACTIONS } from '../actionContracts.js';

describe('Dispatcher V3 start-call intent', () => {
  const speakerCallsign = 'INDIANA-1';

  it('creates and assigns a warrant service from normal radio language', () => {
    const result = planDeterministicV3Intent({
      transcript: 'start a warrant service at 58 Cripps St, Blairsville PA',
      speakerCallsign,
    });

    expect(result).toMatchObject({
      action: V3_ACTIONS.CREATE_CALL,
      confidence: 1,
      reason: 'deterministic_start_call',
      input: {
        type: 'WARRANT SERVICE',
        location: '58 Cripps St, Blairsville PA',
        unitRefs: [speakerCallsign],
      },
    });
  });

  it('works for other call natures instead of hardcoding warrant service', () => {
    const result = planDeterministicV3Intent({
      transcript: 'start a building check at 100 Main St, Indiana PA',
      speakerCallsign,
    });

    expect(result).toMatchObject({
      action: V3_ACTIONS.CREATE_CALL,
      input: {
        type: 'BUILDING CHECK',
        location: '100 Main St, Indiana PA',
        unitRefs: [speakerCallsign],
      },
    });
  });

  it('honors an explicit request not to assign anyone', () => {
    const result = planDeterministicV3Intent({
      transcript: "create a building check at 100 Main St, Indiana PA, don't assign anybody",
      speakerCallsign,
    });

    expect(result).toMatchObject({
      action: V3_ACTIONS.CREATE_CALL,
      input: {
        type: 'BUILDING CHECK',
        location: '100 Main St, Indiana PA',
      },
    });
    expect(result.input.unitRefs).toBeUndefined();
  });
});
