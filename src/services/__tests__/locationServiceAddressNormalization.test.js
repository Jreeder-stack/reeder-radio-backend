import { describe, expect, it } from 'vitest';
import { normalizeAddressRecord } from '../locationService.js';

describe('radio address normalization', () => {
  it('accepts the legacy public-geocoder payload used for an MNI address', () => {
    const result = normalizeAddressRecord({
      name: '132 Pechin Road, Dunbar, PA',
      address: '132 PECHIN ROAD, DUNBAR, PA',
      city: null,
      state: 'PA',
      latitude: 39.976,
      longitude: -79.615,
    }, 'PUBLIC_GEOCODER');

    expect(result).toMatchObject({
      road: '132 PECHIN ROAD',
      streetAddress: '132 PECHIN ROAD',
      city: 'DUNBAR',
      state: 'PA',
      businessName: null,
      lat: 39.976,
      lng: -79.615,
    });
  });

  it('preserves a real MAI business name as a named premise', () => {
    const result = normalizeAddressRecord({
      name: 'Fayette County Fair',
      address: '132 Pechin Road',
      city: 'Dunbar',
      state: 'PA',
      latitude: 39.976,
      longitude: -79.615,
    }, 'MAI');

    expect(result).toMatchObject({
      road: 'Fayette County Fair — 132 Pechin Road',
      city: 'Dunbar',
      state: null,
      postalState: 'PA',
      businessName: 'Fayette County Fair',
    });
  });
});
