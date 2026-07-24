import { describe, expect, it } from 'vitest';
import {
  IDENTIFY_RESULT,
  WAKE_RESULT,
  normalizeUnitId,
  parseIdentify,
  parseWake,
} from '../wakeGate.js';

describe('wakeGate spoken callsign numbers', () => {
  it('recognizes Central from Indiana-1', () => {
    expect(parseWake('Central from Indiana-1')).toEqual({
      kind: WAKE_RESULT.WAKE_WITH_UNIT,
      unit: 'INDIANA-1',
    });
  });

  it('recognizes Azure STT spelling the unit number as a word', () => {
    expect(parseWake('Central from Indiana one.')).toEqual({
      kind: WAKE_RESULT.WAKE_WITH_UNIT,
      unit: 'INDIANA-1',
    });
  });

  it('recognizes a spoken callsign with an inline request', () => {
    expect(parseWake('Central from Indiana one, show me en route.')).toEqual({
      kind: WAKE_RESULT.WAKE_WITH_REQUEST,
      unit: 'INDIANA-1',
      remainder: 'show me en route',
    });
  });

  it('normalizes multi-digit spoken unit numbers', () => {
    expect(normalizeUnitId('Lincoln twenty one')).toBe('LINCOLN-21');
    expect(normalizeUnitId('County one zero two')).toBe('COUNTY-102');
    expect(normalizeUnitId('Beaver one hundred twenty three')).toBe('BEAVER-123');
  });

  it('accepts spoken callsigns during the identify step too', () => {
    expect(parseIdentify('Indiana one')).toEqual({
      kind: IDENTIFY_RESULT.IDENTIFY_UNIT_ONLY,
      unit: 'INDIANA-1',
    });

    expect(parseIdentify('Central from Indiana one')).toEqual({
      kind: IDENTIFY_RESULT.IDENTIFY_CENTRAL_UNIT,
      unit: 'INDIANA-1',
    });
  });
});
