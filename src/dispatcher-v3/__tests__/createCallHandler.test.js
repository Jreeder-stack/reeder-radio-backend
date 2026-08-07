import { describe, expect, it, vi } from 'vitest';
import { createResolvedCallHandler } from '../createCallHandler.js';

describe('createResolvedCallHandler', () => {
  it('resolves a named place before creating the CAD call', async () => {
    const gateway = {
      get: vi.fn().mockResolvedValue({
        success: true,
        source: 'PUBLIC_GEOCODER',
        location: {
          address: '132 Pechin Rd',
          city: 'Dunbar',
          municipality: 'Dunbar',
          state: 'PA',
        },
      }),
      post: vi.fn().mockResolvedValue({ success: true, call: { id: 'call-1' } }),
    };
    const resolveSafeCallsign = vi.fn().mockResolvedValue('INDIANA-1');
    const handler = createResolvedCallHandler({ gateway, resolveSafeCallsign });

    await handler({
      input: {
        type: 'BUILDING CHECK',
        location: 'Fayette County Fair',
        city: 'Dunbar',
        unitIds: ['unit-uuid'],
      },
      correlationId: 'corr-1',
    });

    expect(gateway.get).toHaveBeenCalledWith('/api/radio/locations/resolve', {
      correlationId: 'corr-1',
      query: { q: 'Fayette County Fair, Dunbar' },
    });
    expect(gateway.post).toHaveBeenCalledWith('/api/radio/call', expect.objectContaining({
      type: 'BUILDING CHECK',
      location: '132 Pechin Rd',
      city: 'Dunbar',
      units: ['INDIANA-1'],
    }), { correlationId: 'corr-1', timeoutMs: 20000 });

    const postedBody = gateway.post.mock.calls[0][1];
    expect(postedBody.municipality).toBeUndefined();
  });

  it('uses MAI municipality when the Master Address Index provides it', async () => {
    const gateway = {
      get: vi.fn().mockResolvedValue({
        success: true,
        source: 'MAI',
        location: {
          address: '1950 DUG HILL RD',
          city: 'ROSSITER',
          municipality: 'CANOE TOWNSHIP',
        },
      }),
      post: vi.fn().mockResolvedValue({ success: true }),
    };
    const handler = createResolvedCallHandler({
      gateway,
      resolveSafeCallsign: vi.fn().mockResolvedValue('INDIANA-1'),
    });

    await handler({
      input: {
        type: 'BUILDING CHECK',
        location: '1950 Dug Hill Rd',
        city: 'Rossiter',
        unitIds: ['unit-uuid'],
      },
      correlationId: 'corr-2',
    });

    expect(gateway.post.mock.calls[0][1]).toMatchObject({
      location: '1950 DUG HILL RD',
      city: 'ROSSITER',
      municipality: 'CANOE TOWNSHIP',
    });
  });

  it('fails closed when Command Link cannot verify the location', async () => {
    const gateway = {
      get: vi.fn().mockRejectedValue(Object.assign(new Error('Location not found'), { statusCode: 404 })),
      post: vi.fn(),
    };
    const handler = createResolvedCallHandler({
      gateway,
      resolveSafeCallsign: vi.fn().mockResolvedValue('INDIANA-1'),
    });

    await expect(handler({
      input: { type: 'BUILDING CHECK', location: 'unknown place', unitIds: ['unit-uuid'] },
      correlationId: 'corr-3',
    })).rejects.toMatchObject({ code: 'CAD_REJECTED' });

    expect(gateway.post).not.toHaveBeenCalled();
  });
});
