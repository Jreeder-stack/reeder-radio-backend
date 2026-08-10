import { describe, expect, it, vi } from 'vitest';
import { createResolvedCallHandler } from '../createCallHandler.js';

describe('createResolvedCallHandler', () => {
  it('resolves a named place, creates the CAD call, and verifies the stored call', async () => {
    const gateway = {
      get: vi.fn()
        .mockResolvedValueOnce({
          success: true,
          source: 'PUBLIC_GEOCODER',
          location: {
            address: '132 Pechin Rd', city: 'Dunbar', municipality: 'Dunbar Borough', state: 'PA',
            crossStreet1: 'University Dr', crossStreet2: 'Fairground Rd',
          },
        })
        .mockResolvedValueOnce({
          success: true,
          call: {
            call_id: 'call-1', type: 'BUILDING CHECK', location: '132 PECHIN RD', city: 'DUNBAR', municipality: 'DUNBAR BOROUGH', state: 'PA',
            cross_street_1: 'UNIVERSITY DR', cross_street_2: 'FAIRGROUND RD',
            status: 'assigned', assigned_units: [{ unit_id: 'unit-uuid', callsign: 'INDIANA-1' }],
          },
        }),
      post: vi.fn().mockResolvedValue({ success: true, call: { call_id: 'call-1' } }),
    };
    const resolveSafeCallsign = vi.fn().mockResolvedValue('INDIANA-1');
    const handler = createResolvedCallHandler({ gateway, resolveSafeCallsign });

    const result = await handler({
      input: { type: 'BUILDING CHECK', location: 'Fayette County Fair', city: 'Dunbar', unitIds: ['unit-uuid'] },
      correlationId: 'corr-1',
    });

    expect(gateway.get).toHaveBeenNthCalledWith(1, '/api/radio/locations/resolve', {
      correlationId: 'corr-1', query: { q: 'Fayette County Fair, Dunbar' },
    });
    expect(gateway.post).toHaveBeenCalledWith('/api/radio/v3/cad/calls', expect.objectContaining({
      type: 'BUILDING CHECK', location: '132 Pechin Rd', city: 'Dunbar', municipality: 'Dunbar Borough',
      cross_street_1: 'University Dr', cross_street_2: 'Fairground Rd', units: ['INDIANA-1'],
    }), { correlationId: 'corr-1', timeoutMs: 20000 });
    expect(gateway.get).toHaveBeenNthCalledWith(2, '/api/radio/v3/cad/calls/call-1', { correlationId: 'corr-1' });
    expect(result).toMatchObject({ success: true, verified: true, call: { call_id: 'call-1' } });
  });

  it('uses MAI municipality when the Master Address Index provides it', async () => {
    const gateway = {
      get: vi.fn()
        .mockResolvedValueOnce({
          success: true,
          source: 'MAI',
          location: { address: '1950 DUG HILL RD', city: 'ROSSITER', municipality: 'CANOE TOWNSHIP' },
        })
        .mockResolvedValueOnce({
          success: true,
          call: {
            call_id: 'call-2', type: 'BUILDING CHECK', location: '1950 DUG HILL RD', city: 'ROSSITER',
            municipality: 'CANOE TOWNSHIP', status: 'assigned', assigned_units: [{ callsign: 'INDIANA-1' }],
          },
        }),
      post: vi.fn().mockResolvedValue({ success: true, call: { call_id: 'call-2' } }),
    };
    const handler = createResolvedCallHandler({ gateway, resolveSafeCallsign: vi.fn().mockResolvedValue('INDIANA-1') });

    await handler({
      input: { type: 'BUILDING CHECK', location: '1950 Dug Hill Rd', city: 'Rossiter', unitIds: ['unit-uuid'] },
      correlationId: 'corr-2',
    });

    expect(gateway.post.mock.calls[0][1]).toMatchObject({
      location: '1950 DUG HILL RD', city: 'ROSSITER', municipality: 'CANOE TOWNSHIP',
    });
  });

  it('verifies an unassigned pending call', async () => {
    const gateway = {
      get: vi.fn()
        .mockResolvedValueOnce({ success: true, source: 'MAI', location: { address: '100 MAIN ST', city: 'ROSSITER' } })
        .mockResolvedValueOnce({ success: true, call: { call_id: 'call-3', type: 'NOISE', location: '100 MAIN ST', city: 'ROSSITER', status: 'pending', assigned_units: [] } }),
      post: vi.fn().mockResolvedValue({ success: true, call: { call_id: 'call-3' } }),
    };
    const handler = createResolvedCallHandler({ gateway, resolveSafeCallsign: vi.fn() });
    const result = await handler({ input: { type: 'NOISE', location: '100 Main St', city: 'Rossiter', unitIds: [] }, correlationId: 'corr-3' });
    expect(result.call.status).toBe('pending');
  });

  it('fails closed when Command Link cannot verify the location', async () => {
    const gateway = {
      get: vi.fn().mockRejectedValue(Object.assign(new Error('Location not found'), { statusCode: 404 })),
      post: vi.fn(),
    };
    const handler = createResolvedCallHandler({ gateway, resolveSafeCallsign: vi.fn().mockResolvedValue('INDIANA-1') });

    await expect(handler({
      input: { type: 'BUILDING CHECK', location: 'unknown place', unitIds: ['unit-uuid'] }, correlationId: 'corr-4',
    })).rejects.toMatchObject({ code: 'CAD_REJECTED' });

    expect(gateway.post).not.toHaveBeenCalled();
  });

  it('rejects a create acknowledgment when the follow-up call is wrong', async () => {
    const gateway = {
      get: vi.fn()
        .mockResolvedValueOnce({ success: true, source: 'MAI', location: { address: '100 MAIN ST', city: 'ROSSITER' } })
        .mockResolvedValueOnce({ success: true, call: { call_id: 'call-5', type: 'NOISE', location: '200 MAIN ST', city: 'ROSSITER', status: 'pending', assigned_units: [] } }),
      post: vi.fn().mockResolvedValue({ success: true, call: { call_id: 'call-5' } }),
    };
    const handler = createResolvedCallHandler({ gateway, resolveSafeCallsign: vi.fn() });
    await expect(handler({ input: { type: 'NOISE', location: '100 Main St', city: 'Rossiter', unitIds: [] }, correlationId: 'corr-5' }))
      .rejects.toMatchObject({ code: 'CAD_REJECTED', details: { field: 'location' } });
  });
});
