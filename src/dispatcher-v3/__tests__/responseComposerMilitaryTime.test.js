import { describe, expect, it } from 'vitest';
import { composeV3Response } from '../responseComposer.js';

const now = new Date('2026-08-07T15:59:00Z');

describe('Dispatcher V3 military-time acknowledgements', () => {
  it.each([
    ['en_route', 'INDIANA-1, showing en route, 1159 hours.'],
    ['available', 'INDIANA-1, showing available, 1159 hours.'],
    ['on_scene', 'INDIANA-1, showing on scene, 1159 hours.'],
    ['out_of_service', 'INDIANA-1, showing out of service, 1159 hours.'],
  ])('appends current military time to %s acknowledgements', (status, expected) => {
    expect(composeV3Response({
      plan: { action: 'SET_UNIT_STATUS', input: { status } },
      result: { success: true, data: {} },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe(expected);
  });

  it('adds military time to routine CAD acknowledgements', () => {
    expect(composeV3Response({
      plan: { action: 'ADD_CALL_NOTE', input: {} },
      result: { success: true, data: {} },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe('INDIANA-1, note added, 1159 hours.');
  });

  it('does not add a second timestamp to a direct time check', () => {
    expect(composeV3Response({
      plan: { action: 'TIME_CHECK', input: {} },
      result: { success: true, data: { timestamp: now.toISOString() } },
      speakerCallsign: 'INDIANA-1',
      now,
    })).toBe('INDIANA-1, 1159 hours.');
  });

  it('keeps radio checks and emergency acknowledgements short', () => {
    expect(composeV3Response({ plan: { action: 'RADIO_CHECK', input: {} }, result: { success: true, data: {} }, speakerCallsign: 'INDIANA-1', now }))
      .toBe('INDIANA-1, loud and clear.');
    expect(composeV3Response({ plan: { action: 'DECLARE_EMERGENCY', input: {} }, result: { success: true, data: {} }, speakerCallsign: 'INDIANA-1', now }))
      .toBe('INDIANA-1, emergency activated.');
  });
});
