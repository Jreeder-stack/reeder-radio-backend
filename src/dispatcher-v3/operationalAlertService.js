import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

function runtimeChannel(runtimeContext) {
  return String(runtimeContext?.roomKey || runtimeContext?.channelId || '').trim();
}

export class V3OperationalAlertService {
  constructor({ signalingService, now = () => Date.now() } = {}) {
    if (!signalingService) throw new TypeError('signalingService is required');
    this.signaling = signalingService;
    this.now = now;
  }

  declareEmergency({ identity, runtimeContext, correlationId, callId = null, location = null, reason = null } = {}) {
    const channelId = runtimeChannel(runtimeContext);
    const dispatchCenterId = String(runtimeContext?.dispatchCenterId || '').trim();
    if (!identity?.unitId || !identity?.callsign) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Resolved unit identity is required for emergency activation');
    }
    if (!channelId) throw new DispatcherV3Error(V3_ERROR_CODES.CHANNEL_REQUIRED, 'Dispatcher V3 channel is required for emergency activation');
    if (!dispatchCenterId) throw new DispatcherV3Error(V3_ERROR_CODES.DISPATCH_CENTER_REQUIRED, 'Dispatch center is required for emergency activation');
    if (!this.signaling.io) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, 'Command Comms signaling is not initialized', { retryable: true });

    const timestamp = this.now();
    const emergencyData = Object.freeze({
      unitId: identity.callsign,
      unitUuid: identity.unitId,
      agencyId: identity.agencyId || runtimeContext?.agencyId || null,
      channelId,
      dispatchCenterId,
      runtimeId: runtimeContext?.runtimeId || null,
      correlationId,
      callId,
      location,
      reason,
      timestamp,
      source: 'ai_dispatcher_v3',
    });

    const existing = this.signaling.emergencyStates?.get(channelId);
    if (existing && existing.unitId !== identity.callsign) {
      throw new DispatcherV3Error(V3_ERROR_CODES.CAD_REJECTED, `Channel ${channelId} already has an active emergency`, { statusCode: 409, details: { channelId, activeUnitId: existing.unitId } });
    }

    this.signaling.emergencyStates?.set(channelId, emergencyData);
    const presence = this.signaling.unitPresence?.get(identity.callsign);
    if (presence) presence.status = 'emergency';

    this.signaling._emitToChannelDispatchers?.(channelId, 'emergency:start', emergencyData);
    this.signaling._emitToChannelDispatchers?.(channelId, 'emergency:force_connect', { ...emergencyData, priority: 'emergency' });

    const unitSocket = this.signaling._findSocketByUnitId?.(identity.callsign);
    unitSocket?.emit?.('location:track_start', { requestedBy: 'ai_dispatcher_v3_emergency', emergency: true, correlationId });

    return Object.freeze({ activated: true, emergency: emergencyData, delivery: Object.freeze({ channelScoped: true, globalPushSuppressed: true }) });
  }

  requestBackup({ identity, runtimeContext, correlationId, callId = null, location = null, reason = null, priority = 'urgent' } = {}) {
    const channelId = runtimeChannel(runtimeContext);
    const dispatchCenterId = String(runtimeContext?.dispatchCenterId || '').trim();
    if (!identity?.unitId || !identity?.callsign) {
      throw new DispatcherV3Error(V3_ERROR_CODES.INVALID_ACTION_INPUT, 'Resolved unit identity is required for backup request');
    }
    if (!channelId) throw new DispatcherV3Error(V3_ERROR_CODES.CHANNEL_REQUIRED, 'Dispatcher V3 channel is required for backup request');
    if (!dispatchCenterId) throw new DispatcherV3Error(V3_ERROR_CODES.DISPATCH_CENTER_REQUIRED, 'Dispatch center is required for backup request');
    if (!this.signaling.io) throw new DispatcherV3Error(V3_ERROR_CODES.CAD_UNAVAILABLE, 'Command Comms signaling is not initialized', { retryable: true });

    const alert = Object.freeze({
      type: 'backup_request',
      unitId: identity.callsign,
      unitUuid: identity.unitId,
      agencyId: identity.agencyId || runtimeContext?.agencyId || null,
      channelId,
      dispatchCenterId,
      runtimeId: runtimeContext?.runtimeId || null,
      correlationId,
      callId,
      location,
      reason,
      priority: priority || 'urgent',
      timestamp: this.now(),
      source: 'ai_dispatcher_v3',
    });

    this.signaling._emitToChannelAll?.(channelId, 'backup:request', alert);

    return Object.freeze({ requested: true, backup: alert, delivery: Object.freeze({ channelScoped: true }) });
  }
}
