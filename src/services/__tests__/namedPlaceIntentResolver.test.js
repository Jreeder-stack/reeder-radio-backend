import { describe, expect, it, vi } from 'vitest';
import {
  buildCanonicalStreetAddress,
  isNamedPlaceIntentCandidate,
  resolveNamedPlaceIntent,
} from '../namedPlaceIntentResolver.js';

describe('named-place intent resolution', () => {
  it('recognizes a named premise as a location candidate', () => {
    expect(isNamedPlaceIntentCandidate({
      intent: 'CREATE_CALL',
      slots: { address: 'Fayette County Fair, Dunbar, PA' },
    })).toBe(true);
  });

  it('does not re-resolve an ordinary street address', async () => {
    const resolver = { forwardGeocode: vi.fn() };
    const result = {
      intent: 'CREATE_CALL',
      slots: { nature: 'BUILDING CHECK', address: '132 Pechin Road, Dunbar, PA' },
    };

    await expect(resolveNamedPlaceIntent(result, resolver)).resolves.toBe(result);
    expect(resolver.forwardGeocode).not.toHaveBeenCalled();
  });

  it('preserves the fair name and uses Dunbar Township without duplicate locality', async () => {
    const resolver = {
      forwardGeocode: vi.fn().mockResolvedValue({
        source: 'MAI',
        businessName: 'Fayette County Fair',
        road: 'Fayette County Fair — 132 Pechin Road',
        city: 'Dunbar Township',
        municipality: 'Dunbar Township',
        state: null,
        lat: 39.976,
        lng: -79.614,
      }),
    };
    const result = {
      intent: 'CREATE_CALL',
      slots: {
        nature: 'BUILDING CHECK',
        address: 'Fayette County Fair, Dunbar, PA',
        priority: 'medium',
      },
    };

    const resolved = await resolveNamedPlaceIntent(result, resolver);

    expect(resolver.forwardGeocode).toHaveBeenCalledWith('Fayette County Fair, Dunbar, PA');
    expect(resolved).toEqual({
      ...result,
      slots: {
        ...result.slots,
        address: 'Fayette County Fair — 132 Pechin Road, Dunbar Township',
      },
    });
  });

  it('falls back to a formatted resolver address when structured fields are unavailable', () => {
    expect(buildCanonicalStreetAddress({
      displayName: 'Fayette County Fair, 132 Pechin Road, Dunbar Township',
    })).toBe('Fayette County Fair, 132 Pechin Road, Dunbar Township');
  });

  it('keeps the original named place when lookup fails', async () => {
    const resolver = { forwardGeocode: vi.fn().mockResolvedValue(null) };
    const result = {
      intent: 'CREATE_CALL',
      slots: { address: 'Fayette County Fair, Dunbar, PA' },
    };

    await expect(resolveNamedPlaceIntent(result, resolver)).resolves.toBe(result);
  });
});
