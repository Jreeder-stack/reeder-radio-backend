import { describe, expect, it } from 'vitest';
import { __createCallHandlerTest } from '../createCallHandler.js';

const { inferCityFromSpokenLocation } = __createCallHandlerTest;

describe('Dispatcher V3 create-call locality fallback', () => {
  it('extracts a city from a comma-delimited spoken address', () => {
    expect(inferCityFromSpokenLocation('58 Cripps St, Blairsville PA')).toBe('Blairsville');
  });

  it('extracts a city from a natural spoken address without a comma', () => {
    expect(inferCityFromSpokenLocation('58 Cripps St Blairsville PA')).toBe('Blairsville');
  });

  it('does not invent a city when none was supplied', () => {
    expect(inferCityFromSpokenLocation('1950 Dug Hill Rd')).toBeNull();
  });
});
