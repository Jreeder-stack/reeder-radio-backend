import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { signalingService } from '../services/signalingService.js';
import pool from '../db/index.js';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

const router = Router();

/**
 * Resolve auth for PTT start/end requests.
 * Primary: unit must be in the live presence map (Socket.IO authenticated).
 * Fallback: valid session cookie whose unit_id or username matches the requested unitId.
 * Returns { channelId, unitId } on success, null (+ response already sent) on failure.
 */
function validatePttRequest(req, res) {
  const { channelId, unitId } = req.body;

  if (!channelId || !unitId) {
    res.status(400).json({ error: 'channelId and unitId required' });
    return null;
  }

  // Primary: live Socket.IO presence
  const presence = signalingService.unitPresence?.get(unitId);
  if (presence) {
    return { channelId, unitId };
  }

  // Fallback: session cookie auth (handles Doze-dropped socket reconnects)
  const sessionUser = req.session?.user;
  if (sessionUser && (sessionUser.unit_id === unitId || sessionUser.username === unitId)) {
    console.log(`[PTT-HTTP] Session fallback auth: unit "${unitId}" not in presence — accepted via session cookie`);
    return { channelId, unitId };
  }

  console.warn(`[PTT-HTTP] Rejected: unit "${unitId}" not in presence and no valid session (cookie=${!!req.headers.cookie})`);
  res.status(403).json({ error: 'Unit not authenticated' });
  return null;
}

router.post('/start', (req, res) => {
  const validated = validatePttRequest(req, res);
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

    console.log(`[PTT-HTTP] PTT START: ${unitId} on ${channelId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[PTT-HTTP] Error on ptt/start:', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.post('/end', (req, res) => {
  const validated = validatePttRequest(req, res);
  if (!validated) return;
  const { channelId, unitId } = validated;

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
    }

    io.to(`channel:${channelId}`).emit('ptt:end', endData);

    if (signalingService._emitCallback) {
      signalingService._emitCallback('pttEnd', endData);
    }

    console.log(`[PTT-HTTP] PTT END: ${unitId} on ${channelId} (${duration}ms)`);
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

  // Fallback: session cookie auth (handles Doze-dropped socket reconnects)
  if (!presence) {
    const sessionUser = req.session?.user;
    const sessionMatchesIdentity = sessionUser &&
      (sessionUser.unit_id === identity || sessionUser.username === identity);

    if (!sessionMatchesIdentity) {
      console.warn(`[PTT-HTTP] Token rejected: unit "${identity}" not in presence and no valid session (cookie=${!!req.headers.cookie})`);
      return res.status(403).json({ error: 'Unit not authenticated' });
    }

    console.log(`[PTT-HTTP] Token session fallback: unit "${identity}" not in presence — accepted via session cookie`);
    // Fall through to channel lookup + token generation below
  }

  // Channel existence + access check
  try {
    const result = await pool.query(
      `SELECT id FROM channels WHERE COALESCE(zone, 'Default') || '__' || name = $1 AND enabled = true LIMIT 1`,
      [room]
    );
    if (!result.rows.length) {
      console.warn(`[PTT-HTTP] Token rejected: unknown room key "${room}"`);
      return res.status(400).json({ error: 'Unknown room' });
    }

    // When presence is live, verify the unit is actually on this channel
    if (presence) {
      const channelNumericId = result.rows[0].id;
      const unitChannels = presence.channels ?? [];
      const onChannel = unitChannels.some(c => Number(c) === channelNumericId);
      if (!onChannel) {
        console.warn(`[PTT-HTTP] Token rejected: unit "${identity}" channels=[${unitChannels.join(',')}] not on channel ${channelNumericId} ("${room}")`);
        return res.status(403).json({ error: 'Unit not assigned to requested channel' });
      }
    }
    // Session fallback: channel existence is sufficient — the unit authenticated
    // previously and the session proves identity; channel assignment is not re-checked
    // since presence (which holds channel list) is temporarily unavailable.
  } catch (dbErr) {
    console.error('[PTT-HTTP] DB lookup failed during token auth:', dbErr.message);
    return res.status(500).json({ error: 'Internal error during channel lookup' });
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
    console.log(`[PTT-HTTP] Service token issued for ${identity} on ${room} (via ${presence ? 'presence' : 'session fallback'})`);
    res.json({ token, livekitUrl: process.env.LIVEKIT_URL });
  } catch (err) {
    console.error('[PTT-HTTP] Token generation failed:', err);
    res.status(500).json({ error: 'Failed to generate token' });
  }
});

export default router;
