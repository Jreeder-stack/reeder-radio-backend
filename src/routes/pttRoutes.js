import { Router } from 'express';
import { randomUUID } from 'crypto';
import { signalingService } from '../services/signalingService.js';
import { floorControlService } from '../services/floorControlService.js';
import pool, { upsertDevice, updateDeviceLastSeen } from '../db/index.js';

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

/**
 * Look up a DB user by unit_id or username and verify they have
 * access to the given numeric channelId via user_channel_access.
 * Returns the user row on success, null otherwise.
 */
async function dbVerifyUnitChannelAccess(identity, channelId) {
  const result = await pool.query(
    `SELECT u.id, u.unit_id, u.username
     FROM users u
     JOIN user_channel_access uca ON uca.user_id = u.id
     WHERE (u.unit_id = $1 OR u.username = $1)
       AND uca.channel_id = $2
     LIMIT 1`,
    [identity, channelId]
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve auth for PTT start/end requests.
 *
 * Primary  : unit in signalingService.unitPresence (Socket.IO authenticated).
 * Fallback : valid session cookie + DB channel access verification.
 *
 * Returns { channelId, unitId, presenceSynthesized } on success,
 * or null (response already sent) on failure.
 */
async function resolveChannel(rawChannelId) {
  if (typeof rawChannelId === 'string' && rawChannelId.includes('__')) {
    const result = await pool.query(
      `SELECT id, COALESCE(zone,'Default') || '__' || name AS room_key FROM channels WHERE COALESCE(zone,'Default') || '__' || name = $1 LIMIT 1`,
      [rawChannelId]
    );
    if (!result.rows[0]) return null;
    return { numericId: result.rows[0].id, roomKey: result.rows[0].room_key };
  }
  const parsed = Number(rawChannelId);
  if (!Number.isFinite(parsed)) return null;
  const result = await pool.query(
    `SELECT id, COALESCE(zone,'Default') || '__' || name AS room_key FROM channels WHERE id = $1 LIMIT 1`,
    [parsed]
  );
  if (!result.rows[0]) return null;
  return { numericId: result.rows[0].id, roomKey: result.rows[0].room_key };
}

async function validatePttRequest(req, res) {
  const { channelId: rawChannelId, unitId } = req.body;

  if (!rawChannelId || !unitId) {
    res.status(400).json({ error: 'channelId and unitId required' });
    return null;
  }

  const deviceId = resolveDeviceId(req);

  const resolved = await resolveChannel(rawChannelId);

  if (!resolved) {
    res.status(400).json({ error: 'Invalid channelId or roomKey' });
    return null;
  }

  const { numericId: numericChannelId, roomKey } = resolved;
  const channelId = roomKey;

  // Primary: live Socket.IO presence
  const presence = signalingService.unitPresence?.get(unitId);
  if (presence) {
    return {
      channelId,
      numericChannelId,
      roomKey,
      unitId,
      deviceId,
      sessionUser: req.session?.user || null,
      presenceSynthesized: !!presence.synthesized,
    };
  }

  // Fallback: session cookie identity match
  const sessionUser = req.session?.user;
  if (!sessionUser) {
    console.warn(`[PTT-HTTP] Rejected ${unitId} on ch${channelId}: not in presence, no session (cookie=${!!req.headers.cookie})`);
    res.status(403).json({ error: 'Unit not authenticated' });
    return null;
  }

  const identityMatchesSession =
    sessionUser.unit_id === unitId || sessionUser.username === unitId;
  if (!identityMatchesSession) {
    console.warn(`[PTT-HTTP] Rejected ${unitId} on ch${channelId}: session belongs to "${sessionUser.username}", not requested unit`);
    res.status(403).json({ error: 'Unit not authenticated' });
    return null;
  }

  let dbUser = null;
  try {
    dbUser = await dbVerifyUnitChannelAccess(unitId, numericChannelId);
  } catch (dbErr) {
    console.error('[PTT-HTTP] DB channel access check failed:', dbErr.message);
    res.status(500).json({ error: 'Internal error during authorization' });
    return null;
  }

  if (!dbUser) {
    console.warn(`[PTT-HTTP] Rejected ${unitId} on ch${channelId}: session valid but no DB channel access`);
    res.status(403).json({ error: 'Unit does not have access to this channel' });
    return null;
  }

  const synthPresence = {
    unitId,
    status: 'online',
    channels: [channelId],
    synthesized: true,
  };
  signalingService.unitPresence.set(unitId, synthPresence);
  console.log(`[PTT-HTTP] Session+DB fallback auth OK: "${unitId}" on ch${channelId} — minimal presence synthesized`);

  return {
    channelId,
    numericChannelId,
    roomKey,
    unitId,
    deviceId,
    sessionUser,
    presenceSynthesized: true,
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
  const { channelId, unitId, presenceSynthesized, sessionUser } = validated;
  let { deviceId } = validated;

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
    if (existingTransmission && existingTransmission.unitId === unitId && existingTransmission.deviceId !== deviceId) {
      console.warn(`[PTT-HTTP] Floor denied for ${unitId}/dev=${deviceId.substring(0, 8)} on ch${channelId}: already transmitting from another device on same unit`);
      return res.status(409).json({
        error: 'Channel busy',
        heldBy: unitId,
        reason: 'already_transmitting_other_device',
      });
    }

    const drainingTx = signalingService.drainingTransmissions?.get(channelId);
    if (drainingTx && drainingTx.deviceId !== deviceId && drainingTx.unitId !== unitId) {
      console.warn(`[PTT-HTTP] Floor denied for ${unitId} on ch${channelId}: channel draining (held by ${drainingTx.unitId})`);
      return res.status(409).json({
        error: 'Channel busy',
        heldBy: drainingTx.unitId,
        reason: 'channel_busy',
      });
    }
    if (drainingTx && (drainingTx.deviceId === deviceId || drainingTx.unitId === unitId)) {
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

    const transmissionData = {
      unitId,
      deviceId,
      floorKey: deviceId,
      channelId,
      timestamp: Date.now(),
      isEmergency,
      source: 'cad',
    };

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
  const { channelId, unitId, presenceSynthesized, sessionUser } = validated;
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

  const deviceType = req.session?.deviceType || 'cad';
  if (deviceId) {
    await ensureDeviceRegistered(deviceId, sessionUser, unitId, deviceType);
  }

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const transmission = signalingService.activeTransmissions.get(channelId);
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
