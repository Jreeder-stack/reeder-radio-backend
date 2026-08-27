import { describe, expect, it } from 'vitest';
import { composeV3Response } from '../responseComposer.js';
import { V3_ACTIONS } from '../actionContracts.js';

describe('Dispatcher V3 verified mutation acknowledgements', () => {
  const now = new Date('2026-08-26T21:45:00-04:00');

  it('does not acknowledge a primary-unit change unless CAD verification succeeded', () => {
    const response = composeV3Response({
      plan: { action: V3_ACTIONS.MAKE_PRIMARY },
      result: { success: true, data: { success: true } },
      speakerCallsign: 'INDIANA-1',
      now,
    });
    expect(response).toBe('INDIANA-1, unable to verify that change in CAD.');
  });

  it('allows a verified primary-unit change to receive a positive response', () => {
    const response = composeV3Response({
      plan: { action: V3_ACTIONS.MAKE_PRIMARY },
      result: { success: true, data: { success: true, verified: true } },
      speakerCallsign: 'INDIANA-1',
      now,
    });
    expect(response).toBe('INDIANA-1, copy.');
  });

  it('blocks a multi-action ten-four when any CAD mutation step lacks verification', () => {
    const response = composeV3Response({
      plan: { action: 'MULTI_ACTION' },
      result: {
        success: true,
        data: {
          steps: [
            { action: V3_ACTIONS.ASSIGN_UNIT, result: { success: true, data: { verified: true } } },
            { action: V3_ACTIONS.SET_UNIT_STATUS, result: { success: true, data: { success: true } } },
          ],
        },
      },
      speakerCallsign: 'INDIANA-1',
      now,
    });
    expect(response).toBe('INDIANA-1, unable to verify that change in CAD.');
  });

  it('keeps non-CAD routine acknowledgements working', () => {
    const response = composeV3Response({
      plan: { action: V3_ACTIONS.REQUEST_BACKUP },
      result: { success: true, data: { requested: true } },
      speakerCallsign: 'INDIANA-1',
      now,
    });
    expect(response).toMatch(/^Ten-four,/);
  });
});
