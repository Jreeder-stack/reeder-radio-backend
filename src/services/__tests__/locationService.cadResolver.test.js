import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const originalCadUrl = process.env.CAD_URL;
const originalCadApiKey = process.env.CAD_API_KEY;

beforeEach(() => {
  process.env.CAD_URL = 'https://cad.example.test';
  process.env.CAD_API_KEY = 'test-radio-key';
  vi.restoreAllMocks();
});

afterEach(() => {
  if (originalCadUrl === undefined) delete process.env.CAD_URL;
  else process.env.CAD_URL = originalCadUrl;
  if (originalCadApiKey === undefined) delete process.env.CAD_API_KEY;
  else process.env.CAD_API_KEY = originalCadApiKey;
  vi.unstubAllGlobals();
});

describe('LocationService Command Link resolver', () => {
  it('resolves a named place through the authenticated radio API', async () => {
    const fetchMock = vi.fn(async (url, options = {}) => {
      expect(String(url)).toContain('/api/radio/locations/resolve');
      expect(String(url)).toContain('q=Fayette+County+Fair%2C+Dunbar%2C+PA');
      expect(options.headers['X-API-Key']).toBe('test-radio-key');
      return {
        ok: true,
        json: async () => ({
          success: true,
          source: 'MAI',
          location: {
            id: 'mai-fair',
            name: 'Fayette County Fairgrounds',
            address: '132 Pechin Road',
            city: 'Dunbar',
            state: 'PA',
            zipCode: '15431',
            latitude: 39.976,
            longitude: -79.614,
          },
        }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { default: locationService } = await import('../locationService.js');
    const result = await locationService.forwardGeocode('Fayette County Fair, Dunbar, PA');

    expect(result).toMatchObject({
      source: 'MAI',
      businessName: 'Fayette County Fairgrounds',
      road: '132 Pechin Road',
      city: 'Dunbar',
      state: 'PA',
      maiAddressId: 'mai-fair',
      lat: 39.976,
      lng: -79.614,
    });
  });
});
