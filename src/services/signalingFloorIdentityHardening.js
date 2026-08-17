import { floorControlService, AI_FLOOR_IDENTITY } from './floorControlService.js';
import { canonicalChannelKey } from './channelKeyUtils.js';
import { audioRelayService } from './audioRelayService.js';
import { installAudioRelaySiblingDeviceHardening } from './audioRelaySiblingDeviceHardening.js';
import { wsAudioBridge } from './wsAudioBridge.js';
import pool from '../db/index.js';

const SWEEP_INTERVAL_MS = 30000;
const ORPHAN_FLOOR_MIN_AGE_MS = 2000;

function floorKeyOf(holder) {
  return holder?.floorKey || holder?.unitId || null;
}

function transmissionFloorKey(transmission) {
  return transmission?.floorKey || transmission?.deviceId || transmission?.unitId || null;
}

function resolveFloorIdentity(service, channelId, rawFloorKey) {
  const floorKey = rawFloorKey || null;
  if (!floorKey) {
    return { floorKey: null, unitId: null, deviceId: null };
  }

  const holderSocket = service._findSocketByFloorKey?.(floorKey) || null;
  const active = service.activeTransmissions?.get(channelId) || null;
  const activeFloorKey = transmissionFloorKey(active);
  const activeMatches = active && activeFloorKey === floorKey;

  return {
    floorKey,
    unitId: holderSocket?.unitId || (activeMatches ? active.unitId : null) || floorKey,
    deviceId: holderSocket?.deviceId || (activeMatches ? active.deviceId : null) || floorKey,
  };
}

async function resolveAuthorizedChannel(unitId, rawChannelId) {
  const requestedChannel = canonicalChannelKey(rawChannelId);
  if (!unitId || !requestedChannel) return null;

  try {
    const accessResult = await pool.query(
      `SELECT uca.channel_id,
              COALESCE(c.zone, 'Default') || '__' || c.name AS compound_key
       FROM user_channel_access uca
       JOIN users u ON uca.user_id = u.id
       JOIN channels c ON uca.channel_id = c.id
       WHERE (u.unit_id = $1 OR u.username = $1)
         AND (c.id::text = $2 OR COALESCE(c.zone, 'Default') || '__' || c.name = $2)
         AND c.enabled = true
       LIMIT 1`,
      [unitId, requestedChannel]
    );

    if (accessResult.rows.length === 0) return null;
    return canonicalChannelKey(accessResult.rows[0].compound_key) || requestedChannel;
  } catch (err) {
    // Permissions are a security boundary. Database errors must fail closed.
    console.error(
      `[ChannelAccess] authorization lookup failed unitId=${unitId} channel=${requestedChannel}:`,
      err.message
    );
    return null;
  }
}

function emitChannelAccessDenied(socket, rawChannelId, action) {
  const channelId = canonicalChannelKey(rawChannelId);
  socket.emit?.('error', {
    code: 'CHANNEL_ACCESS_DENIED',
    message: 'Not authorized for this channel',
    channelId,
    action,
  });
  console.warn(
    `[ChannelAccess] denied action=${action} unitId=${socket.unitId || 'unknown'} channelId=${channelId || rawChannelId || 'unknown'}`
  );
}

function installCadChannelAccessHardening(service) {
  if (service._cadChannelAccessHardeningInstalled) return;
  service._cadChannelAccessHardeningInstalled = true;

  // The legacy CAD RadioClient uses channel:join, while dedicated radios use
  // radio:joinChannel. The dedicated-radio path already checks
  // user_channel_access in signalingService; the legacy path historically did
  // not. Enforce the same database-backed assignment here.
  const originalChannelJoin = service._handleChannelJoin.bind(service);
  service._handleChannelJoin = async function permissionCheckedChannelJoin(socket, data) {
    if (socket.isDispatcher === true) {
      return originalChannelJoin(socket, data);
    }

    const authorizedChannel = await resolveAuthorizedChannel(socket.unitId, data?.channelId);
    if (!authorizedChannel) {
      emitChannelAccessDenied(socket, data?.channelId, 'channel:join');
      return;
    }

    return originalChannelJoin(socket, { ...data, channelId: authorizedChannel });
  };

  // Never rely solely on a prior join check. A crafted client could emit PTT
  // or emergency events directly. Non-dispatchers must already be a member of
  // the channel that passed the authorization check above.
  const guardJoinedChannelAction = (methodName, action) => {
    const original = service[methodName].bind(service);
    service[methodName] = function permissionCheckedChannelAction(socket, data) {
      const channelId = canonicalChannelKey(data?.channelId);
      if (
        socket.isDispatcher !== true &&
        (!channelId || !socket.channels || !socket.channels.has(channelId))
      ) {
        emitChannelAccessDenied(socket, data?.channelId, action);
        return;
      }
      return original(socket, data);
    };
  };

  guardJoinedChannelAction('_handlePttPre', 'ptt:pre');
  guardJoinedChannelAction('_handlePttStart', 'ptt:start');
  guardJoinedChannelAction('_handleEmergencyStart', 'emergency:start');

  console.log('[ChannelAccess] CAD signaling channel authorization hardening installed');
}

function installAudioWsChannelAccessHardening(bridge) {
  if (!bridge || bridge._channelAccessHardeningInstalled) return;
  bridge._channelAccessHardeningInstalled = true;

  const originalAuthenticate = bridge._authenticate.bind(bridge);
  bridge._authenticate = async function permissionCheckedAudioAuthenticate(request) {
    const authResult = await originalAuthenticate(request);
    if (!authResult) return null;

    const user = authResult.user || {};
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const rawChannelId = url.searchParams.get('channelId');
    const unitId = user.unit_id || user.username || null;

    // A bare CAD integration key is a service credential, not a user identity.
    // Accepting ?unitId= with only that key lets a client claim another unit.
    // Command Link already creates a per-user Comms session via cad-login, so
    // require that session (or a hardware radio token) for the audio socket.
    if (authResult.authType === 'cadApiKey') {
      console.warn(
        `[ChannelAccess] AUDIO_WS_REJECTED reason=cad_api_key_without_user_session requestedUnit=${unitId || 'unknown'} channel=${rawChannelId || 'unknown'}`
      );
      return null;
    }

    const isDispatcher =
      user.is_dispatcher === true ||
      user.isDispatcher === true ||
      user.role === 'dispatcher' ||
      user.role === 'admin';

    if (isDispatcher) {
      return authResult;
    }

    const authorizedChannel = await resolveAuthorizedChannel(unitId, rawChannelId);
    if (!authorizedChannel) {
      console.warn(
        `[ChannelAccess] AUDIO_WS_REJECTED reason=channel_access_denied authType=${authResult.authType} unitId=${unitId || 'unknown'} channel=${rawChannelId || 'unknown'}`
      );
      return null;
    }

    return authResult;
  };

  console.log('[ChannelAccess] Audio WebSocket channel authorization hardening installed');
}

function installCorrectConsistencySweep(service) {
  service._startActiveTransmissionsSweep = function startIdentitySafeTransmissionSweep() {
    if (this._transmissionSweepTimer) {
      clearInterval(this._transmissionSweepTimer);
    }

    this._transmissionSweepTimer = setInterval(() => {
      for (const [channelId, transmission] of this.activeTransmissions) {
        const holder = floorControlService.getFloorHolder(channelId);
        const holderFloorKey = floorKeyOf(holder);
        const expectedFloorKey = transmissionFloorKey(transmission);

        if (!holder || holderFloorKey !== expectedFloorKey) {
          this.activeTransmissions.delete(channelId);

          this.io?.to(`channel:${channelId}`).emit('tx:stop', {
            senderUnitId: transmission.unitId,
            senderDeviceId: transmission.deviceId || transmission.floorKey || null,
            channelId,
            timestamp: Date.now(),
            reason: 'consistency_sweep',
          });

          this.io?.to(`channel:${channelId}`).emit('ptt:end', {
            unitId: transmission.unitId,
            senderDeviceId: transmission.deviceId || transmission.floorKey || null,
            channelId,
            timestamp: Date.now(),
            reason: 'consistency_sweep',
          });

          // Only advertise idle when there is no different legitimate floor
          // holder. A mismatched holder can be a newer transmission that won
          // the floor after this activeTransmissions entry became stale.
          if (!holder) {
            this.io?.to(`channel:${channelId}`).emit('channel:idle', {
              channelId,
              timestamp: Date.now(),
              reason: 'consistency_sweep',
            });
          }

          const presence = this.unitPresence.get(transmission.unitId);
          if (presence) presence.status = 'online';

          console.warn(
            `[Signaling] STALE_TRANSMISSION_CLEARED channelId=${channelId} ` +
            `unitId=${transmission.unitId} expectedFloorKey=${expectedFloorKey || 'none'} ` +
            `holderFloorKey=${holderFloorKey || 'none'}`
          );
        }
      }

      // A floor with no active/draining transmission is the inverse stale
      // state: clients can hear "idle" while floor control still rejects PTT.
      // Do not touch the short-lived AI floor here; it owns its own 3s watchdog.
      const activeFloors = floorControlService.getActiveFloors();
      for (const [channelId, holder] of Object.entries(activeFloors)) {
        const floorKey = floorKeyOf(holder);
        if (!floorKey || floorKey === AI_FLOOR_IDENTITY) continue;
        if (this.activeTransmissions.has(channelId)) continue;
        if (this.drainingTransmissions.has(channelId)) continue;

        const grantedAt = Number(holder.grantedAt || 0);
        const ageMs = grantedAt > 0 ? Date.now() - grantedAt : Number.MAX_SAFE_INTEGER;
        if (ageMs < ORPHAN_FLOOR_MIN_AGE_MS) continue;

        const released = floorControlService.forceRelease(channelId);
        if (!released) continue;

        const identity = resolveFloorIdentity(this, channelId, floorKey);
        this.io?.to(`channel:${channelId}`).emit('tx:stop', {
          senderUnitId: identity.unitId,
          senderDeviceId: identity.deviceId,
          channelId,
          timestamp: Date.now(),
          reason: 'orphan_floor_recovery',
        });
        this.io?.to(`channel:${channelId}`).emit('ptt:end', {
          unitId: identity.unitId,
          senderDeviceId: identity.deviceId,
          channelId,
          timestamp: Date.now(),
          reason: 'orphan_floor_recovery',
        });
        this.io?.to(`channel:${channelId}`).emit('channel:idle', {
          channelId,
          timestamp: Date.now(),
          reason: 'orphan_floor_recovery',
        });

        console.warn(
          `[Signaling] ORPHAN_FLOOR_RELEASED channelId=${channelId} ` +
          `floorKey=${floorKey} unitId=${identity.unitId} ageMs=${ageMs}`
        );
      }
    }, SWEEP_INTERVAL_MS);

    this._transmissionSweepTimer.unref?.();
  };
}

function installJoinIdentityNormalization(service) {
  const original = service._handleRadioJoinChannel.bind(service);

  service._handleRadioJoinChannel = async function identitySafeRadioJoin(socket, data) {
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event, payload, ...rest) => {
      if (event === 'channel:floor_taken' && payload?.heldBy) {
        const channelId = canonicalChannelKey(payload.channelId);
        const identity = resolveFloorIdentity(this, channelId, payload.heldBy);
        payload = {
          ...payload,
          heldBy: identity.unitId,
          heldByUnitId: identity.unitId,
          heldByDeviceId: identity.deviceId,
          heldByFloorKey: identity.floorKey,
        };
        console.log(
          `[Signaling] FLOOR_IDENTITY_NORMALIZED_ON_JOIN channelId=${channelId} ` +
          `unitId=${identity.unitId} floorKey=${identity.floorKey}`
        );
      }
      return originalEmit(event, payload, ...rest);
    };

    try {
      return await original(socket, data);
    } finally {
      socket.emit = originalEmit;
    }
  };
}

function installPttIdentityNormalization(service) {
  const originalRadioPttRequest = service._handlePttRequest.bind(service);

  service._handlePttRequest = function identitySafePttRequest(socket, data) {
    const rawChannelId = canonicalChannelKey(data?.channelId);
    const channelId = socket._channelKeyMap?.get(rawChannelId) || rawChannelId;
    const requesterFloorKey = socket.floorKey || socket.deviceId || socket.unitId;
    const existing = this.activeTransmissions.get(channelId);

    if (existing && existing.unitId === socket.unitId) {
      const existingFloorKey = transmissionFloorKey(existing);
      if (existingFloorKey === requesterFloorKey) {
        // Same physical device asking again means its local TX state has already
        // returned to idle. Treat the server record as stale instead of calling
        // the same device "another device" and trapping it behind a busy tone.
        this.activeTransmissions.delete(channelId);
        console.warn(
          `[Signaling] SAME_DEVICE_STALE_TX_CLEARED channelId=${channelId} ` +
          `unitId=${socket.unitId} floorKey=${requesterFloorKey}`
        );
      }
    }

    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event, payload, ...rest) => {
      // Dedicated radios authenticate with a radio token, so the server owns a
      // persistent radio device UUID while older installed APKs may still carry
      // a different app-local UUID. The grant is emitted only to this socket and
      // is already bound to this exact one-shot requestId. Return the requester’s
      // own deviceId at the client validation boundary so the radio cannot reject
      // its own valid grant as foreign. Keep the server floorKey unchanged.
      if (
        event === 'ptt:granted' &&
        socket.isRadioDevice === true &&
        data?.requestId &&
        payload?.requestId === data.requestId &&
        typeof data?.deviceId === 'string' &&
        data.deviceId.trim()
      ) {
        const clientDeviceId = data.deviceId.trim();
        if (payload.targetDeviceId !== clientDeviceId) {
          console.warn(
            `[Signaling] RADIO_GRANT_DEVICE_ID_MAPPED unitId=${socket.unitId} ` +
            `channelId=${channelId} serverDeviceId=${payload.targetDeviceId || socket.deviceId || 'none'} ` +
            `clientDeviceId=${clientDeviceId} requestId=${data.requestId}`
          );
        }
        payload = {
          ...payload,
          targetDeviceId: clientDeviceId,
          serverDeviceId: socket.deviceId || null,
        };
      }

      if (event === 'ptt:denied' && payload?.heldBy) {
        const identity = resolveFloorIdentity(this, channelId, payload.heldBy);
        payload = {
          ...payload,
          heldBy: identity.unitId,
          heldByUnitId: identity.unitId,
          heldByDeviceId: identity.deviceId,
          heldByFloorKey: identity.floorKey,
        };
      }
      return originalEmit(event, payload, ...rest);
    };

    try {
      return originalRadioPttRequest(socket, data);
    } finally {
      socket.emit = originalEmit;
    }
  };

  // The legacy ptt:start path can also surface a raw floor key in ptt:busy.
  const originalPttStart = service._handlePttStart.bind(service);
  service._handlePttStart = function identitySafeLegacyPttStart(socket, data) {
    const channelId = canonicalChannelKey(data?.channelId);
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (event, payload, ...rest) => {
      if (event === 'ptt:busy' && payload?.transmittingUnit) {
        const identity = resolveFloorIdentity(this, channelId, payload.transmittingUnit);
        payload = {
          ...payload,
          transmittingUnit: identity.unitId,
          transmittingUnitId: identity.unitId,
          transmittingDeviceId: identity.deviceId,
          transmittingFloorKey: identity.floorKey,
        };
      }
      return originalEmit(event, payload, ...rest);
    };

    try {
      return originalPttStart(socket, data);
    } finally {
      socket.emit = originalEmit;
    }
  };
}

export function installFloorIdentityHardening(signalingService) {
  if (!signalingService || signalingService._floorIdentityHardeningInstalled) return;

  signalingService._floorIdentityHardeningInstalled = true;
  installCorrectConsistencySweep(signalingService);
  installJoinIdentityNormalization(signalingService);
  installPttIdentityNormalization(signalingService);
  // Install permission wrappers after identity wrappers so the PTT permission
  // boundary remains the outermost guard and the existing identity behavior is
  // preserved once a request is authorized.
  installCadChannelAccessHardening(signalingService);
  installAudioWsChannelAccessHardening(wsAudioBridge);
  installAudioRelaySiblingDeviceHardening(audioRelayService);

  console.log('[Signaling] Floor identity hardening installed');
}
