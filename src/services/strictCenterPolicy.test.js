import { describe, expect, it } from 'vitest';
import {
  normalizeCenterUnitId,
  restrictManagedAliases,
  unitAppearsInCenter,
} from './strictCenterPolicy.js';

describe('strict dispatch-center policy', () => {
  it('normalizes callsigns consistently', () => {
    expect(normalizeCenterUnitId(' indiana 1 ')).toBe('INDIANA-1');
  });

  it('accepts only units returned by the selected CAD center', () => {
    const units = [
      { unit_id: 'SEC-2301' },
      { unitNumber: 'SEC-2302' },
    ];
    expect(unitAppearsInCenter(units, 'sec 2301')).toBe(true);
    expect(unitAppearsInCenter(units, 'INDIANA-1')).toBe(false);
  });

  it('removes bare and foreign channel aliases from managed profiles', () => {
    const aliases = new Set(['OPS1', 'CONSTABLE__OPS1', 'SECURITY__OPS1', '77']);
    restrictManagedAliases(aliases, 'SECURITY__OPS1', 77);
    expect([...aliases].sort()).toEqual(['77', 'SECURITY__OPS1']);
  });
});
