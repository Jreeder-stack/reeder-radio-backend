import { describe, expect, it, vi } from 'vitest';
import { V3OperationalContextService, sanitizeV3OperationalContext } from '../operationalContext.js';
import { materializeV3Plan } from '../planMaterializer.js';

function makeService(calls, units = [
  { unit_id: 'INDIANA-1', status: 'available', zone: 'ZONE 1' },
  { unit_id: 'INDIANA-2', status: 'off_duty', zone: 'ZONE 1' },
]) {
  const gateway = {
    get: vi.fn(async (path) => {
      if (path === '/api/radio/calls') return { success: true, calls };
      if (path === '/api/radio/status-check') return { success: true, units };
      if (path.includes('/call')) return { success: true, call: null };
      throw new Error(`unexpected GET ${path}`);
    }),
  };
  const unitIdentityService = {
    resolve: vi.fn(async (ref) => {
      const value = String(ref || 'INDIANA-1').toUpperCase();
      if (value === 'INDIANA-2' || value === '12') return { unitId: 'unit-2', callsign: 'INDIANA-2', status: 'available' };
      return { unitId: 'unit-1', callsign: 'INDIANA-1', status: 'available' };
    }),
  };
  return {
    service: new V3OperationalContextService({ gateway, unitIdentityService }),
    gateway,
    unitIdentityService,
  };
}

describe('Dispatcher V3 operational context', () => {
  it('includes the center-scoped unit roster and current statuses', async () => {
    const { service } = makeService([]);
    const snapshot = await service.snapshot({ speakerCallsign: 'INDIANA-1', correlationId: 'corr-roster' });

    expect(snapshot.units).toEqual([
      { callsign: 'INDIANA-1', name: null, status: 'available', zone: 'ZONE 1', agency: null, location: null },
      { callsign: 'INDIANA-2', name: null, status: 'off_duty', zone: 'ZONE 1', agency: null, location: null },
    ]);
  });

  it('preserves caller and description context for natural references', () => {
    const sanitized = sanitizeV3OperationalContext({
      activeCalls: [{ id: 'call-1', nature: 'DOMESTIC', location: '100 MAIN ST', callerName: 'JOHN SMITH', description: 'caller behind garage' }],
      units: [],
    });
    expect(sanitized.activeCalls[0]).toMatchObject({ callerName: 'JOHN SMITH', description: 'caller behind garage' });
  });

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

  it('prefers the transmitting unit current call when the action is current-call scoped', async () => {
    const { service } = makeService([
      { id: 'call-1', nature: 'ALARM', location: 'WALMART', status: 'assigned' },
      { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST', status: 'assigned' },
    ]);

    await expect(service.resolveCallId({
      preferCurrentCall: true,
      operationalContext: {
        currentCall: { id: 'call-2' },
        activeCalls: [
          { id: 'call-1', nature: 'ALARM', location: 'WALMART' },
          { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST' },
        ],
      },
    })).resolves.toBe('call-2');
  });

  it.each(['my call', 'my current call', "the call I'm on", 'this call'])(
    'treats explicit self reference as the current call even with other calls active: %s',
    async (callRef) => {
      const { service } = makeService([]);
      await expect(service.resolveCallId({
        callRef,
        operationalContext: {
          currentCall: { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST' },
          activeCalls: [
            { id: 'call-1', nature: 'ALARM', location: 'WALMART' },
            { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST' },
          ],
        },
      })).resolves.toBe('call-2');
    },
  );

  it('does not guess which call "that call" means when multiple calls are active', async () => {
    const { service } = makeService([]);
    await expect(service.resolveCallId({
      callRef: 'that call',
      operationalContext: {
        currentCall: { id: 'call-2' },
        activeCalls: [
          { id: 'call-1', nature: 'ALARM', location: 'WALMART' },
          { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST' },
        ],
      },
    })).rejects.toMatchObject({ code: 'CALL_AMBIGUOUS' });
  });

  it('resolves a natural call reference by nature or location', async () => {
    const { service } = makeService([
      { id: 'call-1', nature: 'ALARM', location: 'WALMART', status: 'assigned' },
      { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST', status: 'assigned' },
    ]);

    await expect(service.resolveCallId({ callRef: 'Walmart alarm' })).resolves.toBe('call-1');
    await expect(service.resolveCallId({ callRef: 'the domestic' })).resolves.toBe('call-2');
  });

  it("resolves Smith's call using caller context", async () => {
    const { service } = makeService([
      { id: 'call-1', nature: 'ALARM', location: 'WALMART', caller_name: 'JANE DOE', status: 'assigned' },
      { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST', caller_name: 'JOHN SMITH', status: 'assigned' },
    ]);

    await expect(service.resolveCallId({ callRef: "Smith's call" })).resolves.toBe('call-2');
  });

  it('requires clarification when the descriptive reference matches two calls equally', async () => {
    const { service } = makeService([
      { id: 'call-1', nature: 'ALARM', location: 'WALMART NORTH', status: 'assigned' },
      { id: 'call-2', nature: 'ALARM', location: 'WALMART SOUTH', status: 'assigned' },
    ]);

    await expect(service.resolveCallId({ callRef: 'the alarm' })).rejects.toMatchObject({ code: 'CALL_AMBIGUOUS' });
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

  it("materializes 'put 12 on the call I'm on' against the speaker's current call", async () => {
    const { service, unitIdentityService } = makeService([]);
    const operationalContext = {
      currentCall: { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST' },
      activeCalls: [
        { id: 'call-1', nature: 'ALARM', location: 'WALMART' },
        { id: 'call-2', nature: 'DOMESTIC', location: 'MAIN ST' },
      ],
    };

    const plan = await materializeV3Plan({
      action: 'ASSIGN_UNIT',
      confidence: 0.99,
      input: { unitRef: '12', callRef: "the call I'm on" },
    }, {
      speakerCallsign: 'INDIANA-1', unitIdentityService, operationalContextService: service,
      operationalContext, correlationId: 'corr-compound',
    });

    expect(plan.input).toEqual({ unitId: 'unit-2', callId: 'call-2' });
  });
});
