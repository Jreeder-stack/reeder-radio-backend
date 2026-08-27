import { describe, expect, it } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';
import { V3_ACTIONS } from '../actionContracts.js';

describe('Dispatcher V3 primary-unit intent', () => {
  const speakerCallsign = 'INDIANA-1';

  for (const transcript of [
    'make me primary',
    'show me primary',
    'mark me as the primary unit',
    'set my unit as primary',
    'primary me',
    'make me primary on the current call',
  ]) {
    it(`maps "${transcript}" directly to MAKE_PRIMARY`, () => {
      const result = planDeterministicV3Intent({ transcript, speakerCallsign });
      expect(result).toMatchObject({
        action: V3_ACTIONS.MAKE_PRIMARY,
        input: { unitRef: speakerCallsign },
        confidence: 1,
        reason: 'deterministic_make_primary_self',
      });
    });
  }

  it('still preserves existing status intent handling', () => {
    const result = planDeterministicV3Intent({ transcript: 'show me on scene', speakerCallsign });
    expect(result).toMatchObject({ action: V3_ACTIONS.SET_UNIT_STATUS, input: { unitRef: speakerCallsign, status: 'on_scene' } });
  });
});
