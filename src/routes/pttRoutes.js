import { Router } from 'express';
import { randomUUID } from 'crypto';
import { signalingService } from '../services/signalingService.js';
import { floorControlService } from '../services/floorControlService.js';
import pool, { upsertDevice, updateDeviceLastSeen } from '../db/index.js';
import {
  loadSessionPttPrincipal, loadRadioPttPrincipal, matchPttChannelGrant,
  createPttTransmission, attachPttMetadata, getPttMetadata, ownsPttTransmission, findPttRequest, pttRequestMatches,
} from '../services/pttProvenance.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function resolveDeviceId(req) {
  const fromSession = req.session?.deviceId;
  if (typeof fromSession === 'string' && UUID_RE.test(fromSession)) return fromSession;
  const fromHeader = req.headers['x-device-id'];
  if (typeof fromHeader === 'string' && UUID_RE.test(fromHeader)) return fromHeader;
  const fromBody = req.body?.deviceId;
  if (typeof fromBody === 'string' && UUID_RE.test(fromBody)) return fromBody;
  return null;
}

/** HTTP presence and client device IDs are routing hints, never account proof. */
async function validatePttRequest(req, res) {
  const { channelId: rawChannelId, unitId: requestedUnitId } = req.body;
  if (!rawChannelId || !requestedUnitId) {
    res.status(400).json({ error: 'channelId and unitId required' });
    return null;
  }
  let principal;
  try {
    principal = req.session?.user && req.sessionID
      ? await loadSessionPttPrincipal(req.sessionID)
      : await loadRadioPttPrincipal(req.headers['x-radio-token']);
  } catch (_) {
    res.status(503).json({ error: 'Authentication unavailable' });
    return null;
  }
  if (!principal || ![principal.unitId, principal.username].includes(String(requestedUnitId))) {
    res.status(403).json({ error: 'Unit not authenticated' });
    return null;
  }
  const grant = matchPttChannelGrant(principal, rawChannelId);
  if (!grant) {
    res.status(403).json({ error: 'Unit does not have unambiguous access to this channel' });
    return null;
  }
  const channelId = grant.roomKey;
  const unitId = principal.unitId;
  let presence = signalingService.unitPresence.get(unitId);
  if (!presence) {
    presence = { unitId, status: 'online', channels: [channelId], synthesized: true };
    signalingService.unitPresence.set(unitId, presence);
  }
  return {
    channelId, numericChannelId: grant.channelId, roomKey: grant.roomKey,
    unitId, principal, deviceId: resolveDeviceId(req),
    sessionUser: { id: principal.accountId }, presenceSynthesized: !!presence.synthesized,
  };
}

async function ensureDeviceRegistered(deviceId, sessionUser, unitId, deviceType = 'cad') {
  if (!deviceId) return null;
  try {
    let unitUserId = sessionUser?.id || null;
    if (!unitUserId) {
      const uRow = await pool.query('SELECT id FROM users WHERE unit_id = $1 OR username = $1 LIMIT 1', [unitId]);
      unitUserId = uRow.rows[0]?.id || null;
    }
    const label = `${unitId} ${deviceType.toUpperCase()}`;
    await upsertDevice(deviceId, unitUserId, deviceType, label);
    return deviceId;
  } catch (e) {
    console.warn('[PTT-HTTP] Device upsert failed (non-fatal):', e.message);
    return deviceId;
  }
}

router.post('/start', async (req, res) => {
  const validated = await validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId, presenceSynthesized, sessionUser, principal } = validated;
  let { deviceId } = validated;
  if (findPttRequest(principal, channelId, req.body.requestId)) {
    return res.json({ success: true, duplicate: true });
  }

  // CAD HTTP PTT requires a device identity so the originating device can be
  // distinguished from sibling devices on the same unitId (e.g. a T320 radio
  // on the same unit). If no deviceId was supplied, mint one and persist it
  // so subsequent calls (and the device list) line up.
  if (!deviceId) {
    deviceId = randomUUID();
    if (req.session) {
      req.session.deviceId = deviceId;
      if (!req.session.deviceType) req.session.deviceType = 'cad';
    }
    console.log(`[PTT-HTTP] Minted ad-hoc deviceId=${deviceId.substring(0, 8)}... for ${unitId} (no session/header deviceId provided)`);
  }
  const deviceType = req.session?.deviceType || 'cad';
  await ensureDeviceRegistered(deviceId, sessionUser, unitId, deviceType);

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const existingTransmission = signalingService.activeTransmissions.get(channelId);
    if (existingTransmission && ownsPttTransmission(getPttMetadata(existingTransmission), principal)
        && existingTransmission.deviceId === deviceId) {
      return res.json({ success: true, deviceId, duplicate: true });
    }
    if (existingTransmission && existingTransmission.unitId === unitId) {
      console.warn(`[PTT-HTTP] Floor denied for ${unitId}/dev=${deviceId.substring(0, 8)} on ch${channelId}: already transmitting from another device on same unit`);
      return res.status(409).json({
        error: 'Channel busy',
        heldBy: unitId,
        reason: 'already_transmitting_other_device',
      });
    }

    const drainingTx = signalingService.drainingTransmissions?.get(channelId);
    if (drainingTx && !ownsPttTransmission(getPttMetadata(drainingTx.transmission), principal)) {
      console.warn(`[PTT-HTTP] Floor denied for ${unitId} on ch${channelId}: channel draining (held by ${drainingTx.unitId})`);
      return res.status(409).json({
        error: 'Channel busy',
        heldBy: drainingTx.unitId,
        reason: 'channel_busy',
      });
    }
    if (drainingTx && ownsPttTransmission(getPttMetadata(drainingTx.transmission), principal)) {
      signalingService._cancelDrain(channelId);
    }

    const isEmergency = signalingService.emergencyStates?.has(channelId) || false;
    const floorResult = floorControlService.requestFloor(channelId, deviceId, {
      isEmergency,
      emergencyStates: signalingService.emergencyStates,
    });

    if (!floorResult.granted) {
      console.warn(`[PTT-HTTP] Floor denied for ${unitId}/dev=${deviceId.substring(0, 8)} on ch${channelId}: held by ${floorResult.heldBy}`);
      return res.status(409).json({
        error: 'Channel busy',
        heldBy: floorResult.heldBy || 'unknown',
        reason: floorResult.reason,
      });
    }

    if (existingTransmission) {
      signalingService._emitTransmissionEnd(existingTransmission, {
        unitId: existingTransmission.unitId, channelId, timestamp: Date.now(), reason: 'preempted_emergency',
      });
    }
    const transmissionData = {
      unitId,
      deviceId,
      floorKey: deviceId,
      channelId,
      timestamp: Date.now(),
      isEmergency,
      source: 'cad',
    };

    attachPttMetadata(transmissionData, createPttTransmission(principal, {
      channelId, source: 'http-ptt', captureStartedAt: transmissionData.timestamp, clientRequestId: req.body.requestId,
    }));
    signalingService.activeTransmissions.set(channelId, transmissionData);

    // Only mutate per-unit presence.status when the presence belongs to this
    // CAD client (i.e. it was synthesized for us). If a real socket-presence
    // exists for the same unitId (e.g. a T320 radio), do NOT flip its state —
    // that would make the sibling device appear to be transmitting itself.
    const presence = signalingService.unitPresence.get(unitId);
    if (presence && presence.synthesized) {
      presence.status = 'transmitting';
    }

    signalingService._emitToChannelExcludingDevice(channelId, 'tx:start', {
      senderUnitId: unitId,
      senderDeviceId: deviceId,
      channelId,
      timestamp: Date.now(),
      isEmergency: isEmergency || false,
    }, deviceId);

    signalingService._emitToChannelExcludingDevice(channelId, 'ptt:start', transmissionData, deviceId);

    signalingService._emitToChannelExcludingDevice(channelId, 'channel:busy', {
      channelId,
      heldBy: unitId,
      heldByDeviceId: deviceId,
      timestamp: Date.now(),
    }, deviceId);

    updateDeviceLastSeen(deviceId).catch(() => {});

    if (signalingService._emitCallback) {
      signalingService._emitCallback('pttStart', transmissionData);
    }

    console.log(`[PTT-HTTP] PTT START: ${unitId}/dev=${deviceId.substring(0, 8)} source=cad on ch${channelId}`);
    res.json({ success: true, deviceId });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/start:', err);
    floorControlService.releaseFloor(channelId, deviceId);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/end', async (req, res) => {
  const validated = await validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId, presenceSynthesized, sessionUser, principal } = validated;
  let { deviceId } = validated;

  if (!deviceId) {
    // Fall back to whatever device currently holds the floor for this unit so
    // /end still works for legacy clients that haven't started sending the
    // deviceId yet. Otherwise we would orphan the transmission.
    const tx = signalingService.activeTransmissions.get(channelId);
    if (tx && tx.unitId === unitId && tx.deviceId) {
      deviceId = tx.deviceId;
    }
  }

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const transmission = signalingService.activeTransmissions.get(channelId);
    if (!transmission) return res.json({ success: true, ignored: true });
    if (!ownsPttTransmission(getPttMetadata(transmission), principal)
        || !pttRequestMatches(getPttMetadata(transmission), req.body.requestId)) {
      return res.status(403).json({ error: 'Transmission belongs to another authenticated connection' });
    }
    if (transmission && deviceId && transmission.deviceId && transmission.deviceId !== deviceId) {
      console.warn(`[PTT-HTTP] PTT END deviceId mismatch for ${unitId}: floor held by dev=${transmission.deviceId?.substring(0, 8)}, end from dev=${deviceId.substring(0, 8)} — ignoring`);
      return res.json({ success: true, ignored: true });
    }

    const duration = transmission ? Date.now() - transmission.timestamp : 0;
    const floorKey = transmission?.floorKey || deviceId || unitId;

    const endData = {
      unitId,
      senderDeviceId: deviceId || null,
      channelId,
      timestamp: Date.now(),
      duration,
      source: 'cad',
    };

    const presence = signalingService.unitPresence.get(unitId);
    if (presence && presence.synthesized) {
      presence.status = 'online';
    }

    signalingService._beginTransmissionDrain({
      channelId,
      unitId,
      deviceId: deviceId || null,
      floorKey,
      endData,
      presenceSynthesized: !!presenceSynthesized,
    });

    if (deviceId) updateDeviceLastSeen(deviceId).catch(() => {});

    console.log(`[PTT-HTTP] PTT END (draining): ${unitId}/dev=${deviceId ? deviceId.substring(0, 8) : 'none'} on ch${channelId} (${duration}ms)`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/end:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/token', async (req, res) => {
  res.status(410).json({ error: 'Audio Transport tokens are no longer issued. Audio uses WebSocket transport.' });
});


export default router;
