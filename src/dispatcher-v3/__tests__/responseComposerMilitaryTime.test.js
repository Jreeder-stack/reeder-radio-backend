import { describe, expect, it } from 'vitest';
import { composeV3Response, formatMilitaryTimeForSpeech } from '../responseComposer.js';

const now = new Date('2026-08-07T15:59:00Z');

describe('Dispatcher V3 military-time acknowledgements', () => {
  it.each([
    'en_route',
    'available',
    'on_scene',
    'out_of_service',
  ])('uses ten-four plus current military time for %s acknowledgements', (status) => {
    expect(composeV3Response({
      plan: { action: 'SET_UNIT_STATUS', input: { status } },
      result: { success: true, data: {} },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe('Ten-four, eleven fifty-nine hours.');
  });

  it('uses ten-four plus spoken military time for routine CAD acknowledgements', () => {
    expect(composeV3Response({
      plan: { action: 'ADD_CALL_NOTE', input: {} },
      result: { success: true, data: {} },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe('Ten-four, eleven fifty-nine hours.');
  });

  it('does not add a second timestamp to a direct time check', () => {
    expect(composeV3Response({
      plan: { action: 'TIME_CHECK', input: {} },
      result: { success: true, data: { timestamp: now.toISOString() } },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe('INDIANA-1, eleven fifty-nine hours.');
  });

  it('formats military time as dispatcher speech instead of a four-digit number', () => {
    const priorTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      expect(formatMilitaryTimeForSpeech(new Date('2026-08-07T15:59:00Z'))).toBe('eleven fifty-nine hours');
      expect(formatMilitaryTimeForSpeech(new Date('2026-08-07T12:00:00Z'))).toBe('zero eight hundred hours');
      expect(formatMilitaryTimeForSpeech(new Date('2026-08-07T12:05:00Z'))).toBe('zero eight zero five hours');
      expect(formatMilitaryTimeForSpeech(new Date('2026-08-07T17:00:00Z'))).toBe('thirteen hundred hours');
      expect(formatMilitaryTimeForSpeech(new Date('2026-08-07T04:00:00Z'))).toBe('zero hundred hours');
    } finally {
      if (priorTz === undefined) delete process.env.TZ;
      else process.env.TZ = priorTz;
    }
  });

  it('keeps radio checks short and never announces voice-triggered emergency activation', () => {
    expect(composeV3Response({ plan: { action: 'RADIO_CHECK', input: {} }, result: { success: true, data: {} }, speakerCallsign: 'INDIANA-1', now }))
      .toBe('INDIANA-1, loud and clear.');
    expect(composeV3Response({ plan: { action: 'DECLARE_EMERGENCY', input: {} }, result: { success: false, error: { code: 'UNAUTHORIZED' } }, speakerCallsign: 'INDIANA-1', now }))
      .toBe(`INDIANA-1, unable. That action isn't authorized.`);
  });

  it('reads active calls from the CAD screen context', () => {
    expect(composeV3Response({
      plan: { action: 'LIST_ACTIVE_CALLS', input: {} },
      result: { success: true, data: { calls: [{ call_number: '26-101', nature: 'FIGHT', location: '100 MAIN ST' }] } },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe('INDIANA-1, 1 active call: call 26-101, FIGHT at 100 MAIN ST.');
  });

  it('asks for disposition instead of acknowledging an unperformed clear', () => {
    expect(composeV3Response({
      plan: { action: 'CLEAR_UNIT', input: { callId: 'call-1' } },
      result: { success: false, error: { code: 'DISPOSITION_REQUIRED' } },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe(`INDIANA-1, what's your disposition?`);
  });
});
