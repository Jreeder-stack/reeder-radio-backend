import { describe, expect, it, vi } from 'vitest';
import { V3OperationalContextService } from '../operationalContext.js';
import { materializeV3Plan } from '../planMaterializer.js';

function makeService(calls) {
  const gateway = {
    get: vi.fn(async (path) => {
      if (path === '/api/radio/calls') return { success: true, calls };
      if (path.includes('/call')) return { success: true, call: null };
      throw new Error(`unexpected GET ${path}`);
    }),
  };
  const unitIdentityService = {
    resolve: vi.fn(async (ref) => ({ unitId: 'unit-1', callsign: String(ref || 'INDIANA-1'), status: 'available' })),
  };
  return {
    service: new V3OperationalContextService({ gateway, unitIdentityService }),
    gateway,
    unitIdentityService,
  };
}

describe('Dispatcher V3 operational context', () => {
  it('resolves an implicit call when exactly one active call exists', async () => {
    const { service } = makeService([
      { id: 'call-1', call_number: '2026-000123', nature: 'ALARM', location: 'WALMART', status: 'assigned' },
    ]);

    await expect(service.resolveCallId()).resolves.toBe('call-1');
  });

  it('refuses to guess when more than one active call exists', async () => {
    const { service } = makeService([
      { id: 'call-1', nature: 'ALARM', location: 'WALMART', status: 'assigned' },
      { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST', status: 'assigned' },
    ]);

    await expect(service.resolveCallId()).rejects.toMatchObject({ code: 'CALL_AMBIGUOUS' });
  });

  it('resolves a natural call reference by nature or location', async () => {
    const { service } = makeService([
      { id: 'call-1', nature: 'ALARM', location: 'WALMART', status: 'assigned' },
      { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST', status: 'assigned' },
    ]);

    await expect(service.resolveCallId({ callRef: 'Walmart alarm' })).resolves.toBe('call-1');
  });

  it('materializes attach-me against the only active call', async () => {
    const { service, unitIdentityService } = makeService([
      { id: 'call-1', call_number: '2026-000123', nature: 'ALARM', location: 'WALMART', status: 'assigned' },
    ]);

    const plan = await materializeV3Plan({
      action: 'ASSIGN_UNIT',
      confidence: 0.99,
      input: { unitRef: 'INDIANA-1' },
    }, {
      speakerCallsign: 'INDIANA-1',
      unitIdentityService,
      operationalContextService: service,
      correlationId: 'corr-1',
    });

    expect(plan.input).toEqual({ unitId: 'unit-1', callId: 'call-1' });
  });
});
