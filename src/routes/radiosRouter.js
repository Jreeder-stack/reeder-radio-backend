import express from 'express';
import crypto from 'crypto';
import { radioAuth } from '../middleware/radioAuth.js';
import { requireAdmin, requireDispatcher, requireAuthOrRadioToken } from '../middleware/auth.js';
import {
  getRadioBySerial,
  createRadio,
  updateRadioLastSeen,
  getAllRadios,
  getRadioById,
  assignRadioUnit,
  setRadioLocked,
  getAllUsers,
  updateRadioFcmToken,
  setRadioKioskUnlockExpiresAt,
  clearRadioKioskUnlockExpiresAt,
  logActivity,
} from '../db/index.js';
import pool from '../db/index.js';
import { signalingService } from '../services/signalingService.js';
import { sendDataToRadioToken } from '../services/fcmService.js';

const DEFAULT_KIOSK_UNLOCK_MINUTES = 15;
const MAX_KIOSK_UNLOCK_MINUTES = 240;

let _io = null;
export function setRadiosIo(io) {
  _io = io;
}

function _findRadioSocket(radioId) {
  if (!_io) return null;
  for (const [, socket] of _io.sockets.sockets) {
    if (socket.radioId === radioId) return socket;
  }
  return null;
}

const router = express.Router();

router.post('/register', async (req, res) => {
  const { serial, imei } = req.body;

  if (!serial || typeof serial !== 'string' || serial.trim() === '') {
    return res.status(400).json({ error: 'Serial number is required' });
  }

  const serialNumber = serial.trim();

  try {
    const existing = await getRadioBySerial(serialNumber);
    if (existing) {
      return res.status(200).json({
        radioId: existing.radio_id,
        token: existing.token,
        message: 'This serial number is already registered — existing token re-issued',
      });
    }

    const token = crypto.randomBytes(32).toString('hex');
    let radio;
    try {
      radio = await createRadio(serialNumber, imei || null, token);
    } catch (insertErr) {
      if (insertErr.code === '23505') {
        const conflict = await getRadioBySerial(serialNumber);
        if (conflict) {
          return res.status(200).json({
            radioId: conflict.radio_id,
            token: conflict.token,
            message: 'This serial number is already registered — existing token re-issued',
          });
        }
      }
      throw insertErr;
    }

    return res.status(201).json({
      radioId: radio.radio_id,
      token: radio.token,
    });
  } catch (err) {
    console.error('[Radios] Register error:', err);
    return res.status(500).json({ error: 'Registration failed — server error' });
  }
});

router.post('/ping', radioAuth, async (req, res) => {
  try {
    await updateRadioLastSeen(req.radio.radio_id);
    const radio = req.radio;
    let assignedUnitId = radio.assigned_unit_id || null;
    let unitId = null;
    if (assignedUnitId) {
      try {
        const userRow = await pool.query(
          'SELECT unit_id, username FROM users WHERE id = $1',
          [assignedUnitId]
        );
        if (userRow.rows.length > 0) {
          const u = userRow.rows[0];
          unitId = u.unit_id || u.username || null;
        }
      } catch (e) {
        console.warn('[Radios] Could not resolve assigned user for ping:', e.message);
      }
    }
    let kioskUnlockExpiresAt = null;
    if (radio.kiosk_unlock_expires_at) {
      const expiresMs = new Date(radio.kiosk_unlock_expires_at).getTime();
      if (expiresMs > Date.now()) {
        kioskUnlockExpiresAt = expiresMs;
      } else {
        try {
          await clearRadioKioskUnlockExpiresAt(radio.radio_id);
        } catch (clearErr) {
          console.warn('[Radios] Failed to clear expired kiosk unlock window:', clearErr.message);
        }
      }
    }

    return res.json({ ok: true, assignedUnitId, unitId, kioskUnlockExpiresAt });
  } catch (err) {
    console.error('[Radios] Ping error:', err);
    return res.status(500).json({ error: 'Ping failed — server error' });
  }
});

router.get('/', requireDispatcher, async (req, res) => {
  try {
    const radios = await getAllRadios();
    return res.json({ radios });
  } catch (err) {
    console.error('[Radios] List error:', err);
    return res.status(500).json({ error: 'Failed to fetch radio list' });
  }
});

router.get('/users', requireDispatcher, async (req, res) => {
  try {
    const users = await getAllUsers();
    return res.json({ users });
  } catch (err) {
    console.error('[Radios] Users list error:', err);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

router.patch('/:radioId/assign', requireDispatcher, async (req, res) => {
  const { radioId } = req.params;
  const { unit_id, force } = req.body;

  try {
    const radio = await getRadioById(radioId);
    if (!radio) {
      return res.status(404).json({ error: 'Radio not found' });
    }

    let resolvedUserId = null;
    let resolvedUnitIdentity = null;
    if (unit_id !== null && unit_id !== undefined && unit_id !== '') {
      const userResult = await pool.query(
        'SELECT id, unit_id, username FROM users WHERE id = $1',
        [unit_id]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      resolvedUserId = userResult.rows[0].id;
      resolvedUnitIdentity = userResult.rows[0].unit_id || userResult.rows[0].username;
    }

    const updated = await assignRadioUnit(radioId, resolvedUserId);

    const radioSocket = _findRadioSocket(radioId);
    if (radioSocket) {
      signalingService.removeSocketFromChannels(radioSocket, force ? 'force-reassign' : 'reassign');

      if (resolvedUserId !== null) {
        let channelConfig = null;
        try {
          const userRow = await pool.query(
            `SELECT u.unit_id, uca.channel_id, ch.name AS channel_name, ch.zone,
                    COALESCE(ch.zone, 'Default') || '__' || ch.name AS room_key
             FROM users u
             LEFT JOIN user_channel_access uca ON uca.user_id = u.id
             LEFT JOIN channels ch ON ch.id = uca.channel_id
             WHERE u.id = $1`,
            [resolvedUserId]
          );
          channelConfig = userRow.rows;
        } catch (e) {
          console.warn('[Radios] Could not fetch channel config for radio:assigned event:', e.message);
        }
        radioSocket.emit('radio:assigned', {
          unitId: resolvedUnitIdentity,
          channelConfig,
        });
        radioSocket.unitId = resolvedUnitIdentity;
        radioSocket.assignedUnitId = resolvedUserId;
      } else {
        radioSocket.emit('radio:unassigned', {});
        radioSocket.unitId = radioSocket.radioId;
        radioSocket.assignedUnitId = null;
      }
    }

    return res.json({ radio: updated });
  } catch (err) {
    console.error('[Radios] Assign error:', err);
    return res.status(500).json({ error: 'Assignment failed — server error' });
  }
});

router.post('/fcm-token', requireAuthOrRadioToken, async (req, res) => {
  const { fcmToken, radioId: bodyRadioId } = req.body;
  if (!fcmToken || typeof fcmToken !== 'string') {
    return res.status(400).json({ error: 'fcmToken is required' });
  }

  let targetRadioId;

  if (req.radio?.radio_id) {
    // Radio-token auth: use the authenticated radio directly
    targetRadioId = req.radio.radio_id;
  } else {
    // Session auth: only dispatchers/admins may specify an arbitrary radioId;
    // regular users may only update their own assigned radio.
    const isPrivileged = req.user?.is_dispatcher || req.user?.role === 'admin';
    if (bodyRadioId && isPrivileged) {
      targetRadioId = bodyRadioId;
    } else {
      // Resolve via user's own assigned radio
      const userId = req.user?.id;
      if (userId) {
        const row = await pool.query(
          'SELECT radio_id FROM radios WHERE assigned_unit_id = $1 ORDER BY last_seen DESC LIMIT 1',
          [userId]
        );
        if (row.rows.length > 0) {
          targetRadioId = row.rows[0].radio_id;
        }
      }
      // If a non-privileged user specified a bodyRadioId and it differs from their own radio, deny
      if (bodyRadioId && targetRadioId !== bodyRadioId) {
        console.warn(`[Radios] FCM token registration denied: session user ${req.user?.username} tried to target radioId=${bodyRadioId} (owns ${targetRadioId})`);
        return res.status(403).json({ error: 'Not authorized to register FCM token for this radio' });
      }
    }
  }

  if (!targetRadioId) {
    return res.status(400).json({ error: 'Could not determine radio — provide radioId or authenticate with a radio token' });
  }

  try {
    console.log(`[Radios] Registering FCM token for radio_id=${targetRadioId} | authType=${req.radio ? 'radioToken' : 'session'} | user=${req.user?.username || 'unknown'}`);
    const updated = await updateRadioFcmToken(targetRadioId, fcmToken);
    if (!updated) {
      return res.status(404).json({ error: 'Radio not found' });
    }
    return res.json({ success: true });
  } catch (err) {
    console.error('[Radios] FCM token update error:', err);
    return res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

/**
 * Remotely exit kiosk (lock-task) mode on a radio for a configurable window.
 * Stores the expiry on the radio row so a reconnecting radio can re-sync, emits
 * the live `radio:kiosk_unlock` socket event to a connected radio, and falls
 * back to a data-only FCM message so the command still reaches a radio whose
 * socket happens to be offline.
 *
 * Audit row is written to `activity_logs` with action `radio_kiosk_unlock` and
 * details containing the actor, target radio, duration, and computed expiry.
 */
router.post('/:radioId/kiosk-unlock', requireDispatcher, async (req, res) => {
  const { radioId } = req.params;
  const requested = Number(req.body?.duration_minutes);
  let durationMinutes = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : DEFAULT_KIOSK_UNLOCK_MINUTES;
  if (durationMinutes > MAX_KIOSK_UNLOCK_MINUTES) {
    durationMinutes = MAX_KIOSK_UNLOCK_MINUTES;
  }

  try {
    const radio = await getRadioById(radioId);
    if (!radio) {
      return res.status(404).json({ error: 'Radio not found' });
    }

    const expiresAtMs = Date.now() + durationMinutes * 60 * 1000;
    const expiresAtDate = new Date(expiresAtMs);
    const updated = await setRadioKioskUnlockExpiresAt(radioId, expiresAtDate);

    let socketDelivered = false;
    const radioSocket = _findRadioSocket(radioId);
    if (radioSocket) {
      radioSocket.emit('radio:kiosk_unlock', {
        radioId,
        expiresAt: expiresAtMs,
        durationMinutes,
      });
      socketDelivered = true;
    }

    let fcmDelivered = false;
    if (radio.fcm_token) {
      const fcmResult = await sendDataToRadioToken(radio.fcm_token, {
        type: 'kiosk_unlock',
        radioId,
        expiresAt: expiresAtMs,
        durationMinutes,
      });
      fcmDelivered = !!fcmResult?.success;
    }

    try {
      await logActivity(
        req.user?.id || null,
        req.user?.username || 'system',
        'radio_kiosk_unlock',
        {
          radioId,
          durationMinutes,
          expiresAt: expiresAtMs,
          socketDelivered,
          fcmDelivered,
        },
        null
      );
    } catch (auditErr) {
      console.warn('[Radios] kiosk-unlock audit log failed:', auditErr.message);
    }

    console.log(`[Radios] kiosk-unlock radioId=${radioId} by=${req.user?.username || '?'} durationMin=${durationMinutes} socket=${socketDelivered} fcm=${fcmDelivered}`);

    return res.json({
      radio: updated,
      kioskUnlockExpiresAt: expiresAtMs,
      durationMinutes,
      delivery: { socket: socketDelivered, fcm: fcmDelivered },
    });
  } catch (err) {
    console.error('[Radios] kiosk-unlock error:', err);
    return res.status(500).json({ error: 'Kiosk unlock failed — server error' });
  }
});

/**
 * Cancel an active remote-unlock window and tell the radio to re-enter kiosk
 * (lock-task) mode immediately. Same delivery model as kiosk-unlock: live
 * socket event + FCM fallback + audit log.
 */
router.post('/:radioId/kiosk-relock', requireDispatcher, async (req, res) => {
  const { radioId } = req.params;
  try {
    const radio = await getRadioById(radioId);
    if (!radio) {
      return res.status(404).json({ error: 'Radio not found' });
    }

    const updated = await clearRadioKioskUnlockExpiresAt(radioId);

    let socketDelivered = false;
    const radioSocket = _findRadioSocket(radioId);
    if (radioSocket) {
      radioSocket.emit('radio:kiosk_relock', { radioId });
      socketDelivered = true;
    }

    let fcmDelivered = false;
    if (radio.fcm_token) {
      const fcmResult = await sendDataToRadioToken(radio.fcm_token, {
        type: 'kiosk_relock',
        radioId,
      });
      fcmDelivered = !!fcmResult?.success;
    }

    try {
      await logActivity(
        req.user?.id || null,
        req.user?.username || 'system',
        'radio_kiosk_relock',
        { radioId, socketDelivered, fcmDelivered },
        null
      );
    } catch (auditErr) {
      console.warn('[Radios] kiosk-relock audit log failed:', auditErr.message);
    }

    console.log(`[Radios] kiosk-relock radioId=${radioId} by=${req.user?.username || '?'} socket=${socketDelivered} fcm=${fcmDelivered}`);

    return res.json({
      radio: updated,
      delivery: { socket: socketDelivered, fcm: fcmDelivered },
    });
  } catch (err) {
    console.error('[Radios] kiosk-relock error:', err);
    return res.status(500).json({ error: 'Kiosk relock failed — server error' });
  }
});

router.patch('/:radioId/lock', requireAdmin, async (req, res) => {
  const { radioId } = req.params;
  const { is_locked } = req.body;

  if (typeof is_locked !== 'boolean') {
    return res.status(400).json({ error: 'is_locked must be a boolean' });
  }

  try {
    const radio = await getRadioById(radioId);
    if (!radio) {
      return res.status(404).json({ error: 'Radio not found' });
    }

    const updated = await setRadioLocked(radioId, is_locked);

    const radioSocket = _findRadioSocket(radioId);
    if (radioSocket && is_locked) {
      radioSocket.emit('radio:locked', { radioId });
      radioSocket.disconnect(true);
    }

    return res.json({ radio: updated });
  } catch (err) {
    console.error('[Radios] Lock error:', err);
    return res.status(500).json({ error: 'Lock operation failed — server error' });
  }
});

export default router;
