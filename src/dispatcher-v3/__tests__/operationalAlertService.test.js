import { describe, expect, it, vi } from 'vitest';
import { V3OperationalAlertService } from '../operationalAlertService.js';

const identity = Object.freeze({ unitId: 'uuid-1', callsign: 'INDIANA-1', agencyId: 'agency-1' });
const runtime = Object.freeze({ runtimeId: 'runtime-1', channelId: 'OPS1', dispatchCenterId: 'center-1', agencyId: 'agency-1' });

function makeSignaling() {
  return {
    io: {},
    emergencyStates: new Map(),
    unitPresence: new Map([['INDIANA-1', { status: 'online' }]]),
    _emitToChannelDispatchers: vi.fn(),
    _emitToChannelAll: vi.fn(),
    _emitToDispatchers: vi.fn(),
    _emitCallback: vi.fn(),
    _findSocketByUnitId: vi.fn(() => ({ emit: vi.fn() })),
  };
}

describe('V3OperationalAlertService', () => {
  it('activates emergency state only on the selected channel and suppresses global fan-out', () => {
    const signaling = makeSignaling();
    const service = new V3OperationalAlertService({ signalingService: signaling, now: () => 12345 });
    const result = service.declareEmergency({ identity, runtimeContext: runtime, correlationId: 'corr-emerg', callId: 'call-1', location: '100 Main St', reason: 'officer needs assistance' });
    expect(result.activated).toBe(true);
    expect(result.delivery).toEqual({ channelScoped: true, globalPushSuppressed: true });
    expect(signaling.emergencyStates.get('OPS1')).toMatchObject({ unitId: 'INDIANA-1', unitUuid: 'uuid-1', dispatchCenterId: 'center-1', correlationId: 'corr-emerg' });
    expect(signaling.unitPresence.get('INDIANA-1').status).toBe('emergency');
    expect(signaling._emitToChannelDispatchers).toHaveBeenCalledWith('OPS1', 'emergency:start', expect.any(Object));
    expect(signaling._emitToChannelDispatchers).toHaveBeenCalledWith('OPS1', 'emergency:force_connect', expect.objectContaining({ priority: 'emergency' }));
    expect(signaling._emitToDispatchers).not.toHaveBeenCalled();
    expect(signaling._emitCallback).not.toHaveBeenCalled();
  });

  it('rejects a second unit trying to own the same channel emergency state', () => {
    const signaling = makeSignaling();
    signaling.emergencyStates.set('OPS1', { unitId: 'OTHER-1' });
    const service = new V3OperationalAlertService({ signalingService: signaling });
    expect(() => service.declareEmergency({ identity, runtimeContext: runtime, correlationId: 'corr-2' })).toThrow(expect.objectContaining({ code: 'CAD_REJECTED', statusCode: 409 }));
  });

  it('sends backup once to the selected channel with center metadata', () => {
    const signaling = makeSignaling();
    const service = new V3OperationalAlertService({ signalingService: signaling, now: () => 777 });
    const result = service.requestBackup({ identity, runtimeContext: runtime, correlationId: 'corr-backup', callId: 'call-2', location: '200 Oak St', reason: 'multiple subjects', priority: 'urgent' });
    expect(result.requested).toBe(true);
    expect(result.backup).toMatchObject({ unitId: 'INDIANA-1', unitUuid: 'uuid-1', channelId: 'OPS1', dispatchCenterId: 'center-1', correlationId: 'corr-backup', priority: 'urgent', timestamp: 777 });
    expect(signaling._emitToChannelAll).toHaveBeenCalledTimes(1);
    expect(signaling._emitToChannelAll).toHaveBeenCalledWith('OPS1', 'backup:request', result.backup);
    expect(signaling._emitToChannelDispatchers).not.toHaveBeenCalledWith('OPS1', 'backup:request', expect.any(Object));
    expect(signaling._emitToDispatchers).not.toHaveBeenCalled();
  });

  it('fails closed if signaling is not initialized', () => {
    const signaling = makeSignaling();
    signaling.io = null;
    const service = new V3OperationalAlertService({ signalingService: signaling });
    expect(() => service.requestBackup({ identity, runtimeContext: runtime, correlationId: 'corr-3' })).toThrow(expect.objectContaining({ code: 'CAD_UNAVAILABLE' }));
  });
});
