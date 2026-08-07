import { describe, expect, it } from 'vitest';
import { planDeterministicV3Intent } from '../deterministicIntent.js';

const operationalContext = {
  units: [
    { callsign: 'INDIANA-1', status: 'on_duty' },
    { callsign: 'INDIANA-2', status: 'off_duty' },
    { callsign: 'SECURITY-12', status: 'available' },
  ],
};

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
    ['put Indiana 2 on duty', 'INDIANA-2', 'on_duty'],
    ['show Indiana-2 on duty', 'INDIANA-2', 'on_duty'],
    ['mark Security 12 out of service', 'SECURITY-12', 'out_of_service'],
    ['put Security-12 available', 'SECURITY-12', 'available'],
  ])('targets the named roster unit instead of the speaker: %s', (transcript, unitRef, status) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign: 'INDIANA-1', operationalContext })).toMatchObject({
      action: 'SET_UNIT_STATUS',
      input: { unitRef, status },
      confidence: 1,
    });
  });

  it.each([
    ['change me to zone 2', 'ZONE 2'],
    ['switch me to zone 2', 'ZONE 2'],
    ['change zone to north', 'NORTH'],
    ['put me on zone 3', 'ZONE 3'],
  ])('routes zone-change requests to the zone capability: %s', (transcript, zone) => {
    expect(planDeterministicV3Intent({ transcript, speakerCallsign: 'INDIANA-1' })).toMatchObject({
      action: 'CHANGE_UNIT_ZONE',
      input: { unitRef: 'INDIANA-1', zone },
      confidence: 1,
      reason: 'deterministic_zone_change',
    });
  });
});
