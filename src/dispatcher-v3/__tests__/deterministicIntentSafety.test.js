import { describe, expect, it } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';

describe('Dispatcher V3 deterministic intent safety', () => {
  it.each([
    'go en route to the call on my screen',
    'show me en route to the call on my screen',
    'put me en route to my current call',
    'mark me en route to the call',
  ])('recognizes extended en-route phrasing: %s', (transcript) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign: 'INDIANA-1' })).toMatchObject({
      action: 'SET_UNIT_STATUS',
      input: { unitRef: 'INDIANA-1', status: 'en_route' },
      confidence: 1,
    });
  });

  it.each([
    'change me to zone 2',
    'switch me to zone 2',
    'change zone to north',
    'put me on zone 3',
  ])('does not misclassify zone-change requests as a unit status: %s', (transcript) => {
    const plan = planDeterministicV3Intent({ transcript, speakerCallsign: 'INDIANA-1' });
    expect(plan).toMatchObject({
      action: 'CLARIFY',
      confidence: 1,
      reason: 'zone_change_not_yet_supported',
    });
  });
});
