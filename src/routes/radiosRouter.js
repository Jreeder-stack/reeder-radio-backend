import express from 'express';
import crypto from 'crypto';
import { radioAuth } from '../middleware/radioAuth.js';
import { requireAdmin, requireDispatcher } from '../middleware/auth.js';
import {
  getRadioBySerial,
  createRadio,
  updateRadioLastSeen,
  getAllRadios,
  getRadioById,
  assignRadioUnit,
  setRadioLocked,
  getAllUsers,
} from '../db/index.js';
import pool from '../db/index.js';
import { signalingService } from '../services/signalingService.js';

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
    return res.json({ ok: true, assignedUnitId, unitId });
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
  const { unit_id } = req.body;

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
        signalingService.removeSocketFromChannels(radioSocket, 'unassign');
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
