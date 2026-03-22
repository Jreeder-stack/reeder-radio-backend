import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { signalingService } from '../services/signalingService.js';
import pool from '../db/index.js';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const router = Router();

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
    return { channelId, numericChannelId, roomKey, unitId, presenceSynthesized: !!presence.synthesized };
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

  return { channelId, numericChannelId, roomKey, unitId, presenceSynthesized: true };
}

router.post('/start', async (req, res) => {
  const validated = await validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId } = validated;

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const transmissionData = {
      unitId,
      channelId,
      timestamp: Date.now(),
      isEmergency: signalingService.emergencyStates?.has(channelId) || false,
      source: 'native-service',
    };

    signalingService.activeTransmissions.set(channelId, transmissionData);

    const presence = signalingService.unitPresence.get(unitId);
    if (presence) {
      presence.status = 'transmitting';
    }

    io.to(`channel:${channelId}`).emit('ptt:start', transmissionData);

    if (signalingService._emitCallback) {
      signalingService._emitCallback('pttStart', transmissionData);
    }

    console.log(`[PTT-HTTP] PTT START: ${unitId} on ch${channelId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/start:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/end', async (req, res) => {
  const validated = await validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId, presenceSynthesized } = validated;

  try {
    const io = signalingService.io;
    if (!io) {
      console.warn('[PTT-HTTP] Socket.IO not initialized');
      return res.status(503).json({ error: 'Signaling not ready' });
    }

    const transmission = signalingService.activeTransmissions.get(channelId);
    const duration = transmission ? Date.now() - transmission.timestamp : 0;

    const endData = {
      unitId,
      channelId,
      timestamp: Date.now(),
      duration,
      gracePeriodMs: signalingService.GRACE_PERIOD_MS || 3000,
      source: 'native-service',
    };

    signalingService.activeTransmissions.delete(channelId);

    if (signalingService.graceChannels) {
      signalingService.graceChannels.set(channelId, {
        unitId,
        expiresAt: Date.now() + (signalingService.GRACE_PERIOD_MS || 3000),
      });

      setTimeout(() => {
        const grace = signalingService.graceChannels.get(channelId);
        if (grace && grace.unitId === unitId) {
          signalingService.graceChannels.delete(channelId);
        }
      }, signalingService.GRACE_PERIOD_MS || 3000);
    }

    const presence = signalingService.unitPresence.get(unitId);
    if (presence) {
      presence.status = 'online';
      // Clean up synthesized presence entries after PTT end — the unit's socket
      // will re-populate presence properly when its Socket.IO reconnects.
      if (presenceSynthesized) {
        setTimeout(() => {
          const p = signalingService.unitPresence.get(unitId);
          if (p?.synthesized) {
            signalingService.unitPresence.delete(unitId);
            console.log(`[PTT-HTTP] Removed synthesized presence for "${unitId}"`);
          }
        }, (signalingService.GRACE_PERIOD_MS || 3000) + 1000);
      }
    }

    io.to(`channel:${channelId}`).emit('ptt:end', endData);

    if (signalingService._emitCallback) {
      signalingService._emitCallback('pttEnd', endData);
    }

    console.log(`[PTT-HTTP] PTT END: ${unitId} on ch${channelId} (${duration}ms)`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/end:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/token', async (req, res) => {
  const { identity, room } = req.query;

  if (!identity || !room) {
    return res.status(400).json({ error: 'identity and room are required' });
  }

  // Primary: live Socket.IO presence
  const presence = signalingService.unitPresence?.get(identity);

  let authPath = 'presence';

  if (!presence) {
    // Fallback: session cookie identity match
    const sessionUser = req.session?.user;
    const sessionMatchesIdentity = sessionUser &&
      (sessionUser.unit_id === identity || sessionUser.username === identity);

    if (!sessionMatchesIdentity) {
      console.warn(`[PTT-HTTP] Token rejected "${identity}" on "${room}": not in presence, no matching session (cookie=${!!req.headers.cookie})`);
      return res.status(403).json({ error: 'Unit not authenticated' });
    }

    // DB: resolve channel numeric ID from room key and verify access
    let channelRow = null;
    try {
      const result = await pool.query(
        `SELECT c.id
         FROM channels c
         JOIN user_channel_access uca ON uca.channel_id = c.id
         JOIN users u ON uca.user_id = u.id
         WHERE COALESCE(c.zone, 'Default') || '__' || c.name = $1
           AND c.enabled = true
           AND (u.unit_id = $2 OR u.username = $2)
         LIMIT 1`,
        [room, identity]
      );
      channelRow = result.rows[0] ?? null;
    } catch (dbErr) {
      console.error('[PTT-HTTP] DB channel access check for token failed:', dbErr.message);
      return res.status(500).json({ error: 'Internal error during authorization' });
    }

    if (!channelRow) {
      console.warn(`[PTT-HTTP] Token rejected "${identity}" on "${room}": session valid but no DB channel access or unknown room`);
      return res.status(403).json({ error: 'Unit does not have access to this channel' });
    }

    authPath = 'session+db';
    console.log(`[PTT-HTTP] Token session+DB fallback OK: "${identity}" on "${room}"`);
  } else {
    // Presence path: verify the unit is actually on this channel
    try {
      const result = await pool.query(
        `SELECT id FROM channels WHERE COALESCE(zone, 'Default') || '__' || name = $1 AND enabled = true LIMIT 1`,
        [room]
      );
      if (!result.rows.length) {
        console.warn(`[PTT-HTTP] Token rejected: unknown room key "${room}"`);
        return res.status(400).json({ error: 'Unknown room' });
      }
      const channelNumericId = result.rows[0].id;
      const unitChannels = presence.channels ?? [];
      const onChannel = unitChannels.some(c => Number(c) === channelNumericId || c === room);
      if (!onChannel) {
        console.warn(`[PTT-HTTP] Token rejected: unit "${identity}" channels=[${unitChannels.join(',')}] not on channel ${channelNumericId} ("${room}")`);
        return res.status(403).json({ error: 'Unit not assigned to requested channel' });
      }
    } catch (dbErr) {
      console.error('[PTT-HTTP] DB lookup failed during token auth:', dbErr.message);
      return res.status(500).json({ error: 'Internal error during channel lookup' });
    }
  }

  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LiveKit credentials not configured' });
  }

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: identity,
      ttl: '1h',
    });

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    console.log(`[PTT-HTTP] Token issued for "${identity}" on "${room}" (via ${authPath})`);
    res.json({ token, livekitUrl: process.env.LIVEKIT_URL });
  } catch (err) {
    console.error('[PTT-HTTP] Token generation failed:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

export default router;
