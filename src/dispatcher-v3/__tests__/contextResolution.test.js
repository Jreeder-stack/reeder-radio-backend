import { describe, expect, it, vi } from 'vitest';
import { materializeV3Plan } from '../planMaterializer.js';

function identities() {
  return {
    resolve: vi.fn(async (ref) => {
      const value = String(ref).toUpperCase();
      if (value === 'INDIANA-1') return { unitId: 'U1', callsign: 'INDIANA-1' };
      if (value === 'INDIANA-12' || value === '12') return { unitId: 'U12', callsign: 'INDIANA-12' };
      throw new Error(`unknown unit ${ref}`);
    }),
  };
}

describe('Dispatcher V3 contextual materialization', () => {
  it.each(['me', 'myself', 'my unit', 'the transmitting unit'])(
    'resolves self unit language to the transmitting callsign: %s',
    async (unitRef) => {
      const unitIdentityService = identities();
      const result = await materializeV3Plan({
        action: 'SET_UNIT_STATUS',
        input: { unitRef, status: 'available' },
      }, {
        speakerCallsign: 'INDIANA-1', unitIdentityService, correlationId: 'self-1',
      });

      expect(result.input.unitId).toBe('U1');
      expect(unitIdentityService.resolve).toHaveBeenCalledWith('INDIANA-1', { correlationId: 'self-1' });
    },
  );

  it('does not rewrite a specifically named unit to the speaker', async () => {
    const unitIdentityService = identities();
    const operationalContextService = { resolveCallId: vi.fn(async () => 'CALL-1') };
    const result = await materializeV3Plan({
      action: 'ASSIGN_UNIT',
      input: { unitRef: '12', callRef: 'the Walmart alarm' },
    }, {
      speakerCallsign: 'INDIANA-1', unitIdentityService, operationalContextService,
      operationalContext: {}, correlationId: 'named-1',
    });

    expect(result.input).toEqual({ unitId: 'U12', callId: 'CALL-1' });
    expect(unitIdentityService.resolve).toHaveBeenCalledWith('12', { correlationId: 'named-1' });
  });
});
