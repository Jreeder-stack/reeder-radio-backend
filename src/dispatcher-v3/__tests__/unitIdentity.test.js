import { describe, expect, it, vi } from 'vitest';
import { UnitIdentityService } from '../unitIdentity.js';
import { V3_ERROR_CODES } from '../errors.js';

function context() {
  return {
    runtimeId: 'runtime-a',
    profileId: 'profile-a',
    dispatchCenterId: 'center-a',
    channelId: 1,
    roomKey: 'OPS1',
    identity: 'AI-A',
    cadUrl: 'https://cad.example',
    cadApiKey: 'secret',
    scopes: ['unit.read'],
  };
}

describe('UnitIdentityService', () => {
  it('returns immutable unit identity from Command Link', async () => {
    const gateway = {
      get: vi.fn().mockResolvedValue({
        success: true,
        unit: { id: 'uuid-1', unit_number: 'INDIANA-1', agency_id: 'agency-a', status: 'on_duty' },
      }),
    };
    const service = new UnitIdentityService({ gateway, context: context() });
    const result = await service.resolve('indiana-1', { correlationId: 'corr-1' });
    expect(result.unitId).toBe('uuid-1');
    expect(result.callsign).toBe('INDIANA-1');
    expect(result.dispatchCenterId).toBe('center-a');
    expect(Object.isFrozen(result)).toBe(true);
    expect(gateway.get).toHaveBeenCalledWith('/api/radio/unit/resolve-v3', expect.objectContaining({
      query: { unit_ref: 'indiana-1' },
      correlationId: 'corr-1',
    }));
  });

  it('fails closed when Command Link reports ambiguity', async () => {
    const error = new Error('conflict');
    error.details = { body: { error: 'UNIT_AMBIGUOUS', candidates: [{ id: 'a' }, { id: 'b' }] } };
    const service = new UnitIdentityService({ gateway: { get: vi.fn().mockRejectedValue(error) }, context: context() });
    await expect(service.resolve('INDIANA-1')).rejects.toMatchObject({ code: V3_ERROR_CODES.UNIT_AMBIGUOUS, statusCode: 409 });
  });

  it('fails closed when the unit is not in this center', async () => {
    const error = new Error('not found');
    error.details = { body: { error: 'UNIT_NOT_FOUND' } };
    const service = new UnitIdentityService({ gateway: { get: vi.fn().mockRejectedValue(error) }, context: context() });
    await expect(service.resolve('INDIANA-1')).rejects.toMatchObject({ code: V3_ERROR_CODES.UNIT_NOT_FOUND, statusCode: 404 });
  });

  it('rejects malformed success responses instead of using the callsign', async () => {
    const service = new UnitIdentityService({ gateway: { get: vi.fn().mockResolvedValue({ success: true, unit: { unit_number: 'INDIANA-1' } }) }, context: context() });
    await expect(service.resolve('INDIANA-1')).rejects.toMatchObject({ code: V3_ERROR_CODES.CAD_REJECTED });
  });
});
