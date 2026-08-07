import express from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import {
  getRadioBySerial,
  createRadio,
  assignRadioUnit,
  updateRadioFcmToken,
  upsertDevice,
} from '../db/index.js';
import pool from '../db/index.js';

const router = express.Router();
const PHONE_DEVICE_TYPE = 'android_phone';

function normalizedPhoneDevice(req) {
  const deviceType = String(req.headers['x-command-device-type'] || '').trim().toLowerCase();
  const deviceId = String(req.headers['x-command-device-id'] || '').trim().toLowerCase();
  if (deviceType !== PHONE_DEVICE_TYPE || !deviceId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) {
    return { invalid: true };
  }
  return { deviceType, deviceId };
}

async function ensurePhoneRadio(userId, deviceId) {
  await pool.query('ALTER TABLE radios ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true');
  const serialNumber = `ANDROID-PHONE:${deviceId}`;
  let radio = await getRadioBySerial(serialNumber);

  if (!radio) {
    const token = crypto.randomBytes(32).toString('hex');
    try {
      radio = await createRadio(serialNumber, null, token);
    } catch (err) {
      // Concurrent startup/FCM callbacks can race on first registration.
      if (err?.code === '23505') {
        radio = await getRadioBySerial(serialNumber);
      } else {
        throw err;
      }
    }
  }

  if (!radio) throw new Error('Unable to create or resolve phone radio endpoint');

  await assignRadioUnit(radio.radio_id, userId);
  await pool.query(
    `UPDATE radios
        SET device_uuid = $1::uuid,
            assigned_unit_id = $2,
            is_active = true,
            last_seen = CURRENT_TIMESTAMP
      WHERE radio_id = $3`,
    [deviceId, userId, radio.radio_id]
  );
  await upsertDevice(deviceId, userId, PHONE_DEVICE_TYPE, 'Android Phone');

  const refreshed = await pool.query(
    'SELECT id, radio_id, assigned_unit_id, device_uuid, is_active FROM radios WHERE radio_id = $1',
    [radio.radio_id]
  );
  return refreshed.rows[0];
}

/**
 * Intercepts native Android-phone FCM registration before the legacy radios
 * router. A phone is a first-class physical radio endpoint, not merely another
 * session for the user's T320. Each persisted device UUID gets its own radios
 * row and its own FCM token while remaining assigned to the same unit/user.
 */
router.post('/fcm-token', requireAuth, async (req, res, next) => {
  const phone = normalizedPhoneDevice(req);
  if (!phone) return next();
  if (phone.invalid) return res.status(400).json({ error: 'Invalid phone device ID' });

  const fcmToken = typeof req.body?.fcmToken === 'string' ? req.body.fcmToken.trim() : '';
  if (!fcmToken) return res.status(400).json({ error: 'fcmToken is required' });

  try {
    const radio = await ensurePhoneRadio(req.user.id, phone.deviceId);

    // Repair legacy corruption from the old session-auth path, which could put
    // the phone's FCM token onto the user's T320 row. A Firebase registration
    // token represents one app installation and must belong to one radio row.
    await pool.query(
      'UPDATE radios SET fcm_token = NULL WHERE fcm_token = $1 AND radio_id <> $2',
      [fcmToken, radio.radio_id]
    );
    await updateRadioFcmToken(radio.radio_id, fcmToken);

    console.log(`[PhoneRadio] endpoint registered user=${req.user.username} radioId=${radio.radio_id} deviceId=${phone.deviceId}`);
    return res.json({
      success: true,
      radioId: radio.radio_id,
      radioPk: Number(radio.id),
      deviceId: phone.deviceId,
      deviceType: PHONE_DEVICE_TYPE,
    });
  } catch (err) {
    console.error('[PhoneRadio] FCM/endpoint registration failed:', err);
    return res.status(500).json({ error: 'Failed to register phone radio endpoint' });
  }
});

/**
 * Explicit heartbeat/upsert for the phone. This lets the endpoint remain
 * visible in the dispatcher roster even if Firebase does not issue a new token
 * during a given app session.
 */
router.post('/phone-presence', requireAuth, async (req, res) => {
  const phone = normalizedPhoneDevice(req);
  if (!phone || phone.invalid) {
    return res.status(400).json({ error: 'Valid Android phone device headers are required' });
  }

  try {
    const radio = await ensurePhoneRadio(req.user.id, phone.deviceId);
    return res.json({
      success: true,
      radioId: radio.radio_id,
      radioPk: Number(radio.id),
      deviceId: phone.deviceId,
      deviceType: PHONE_DEVICE_TYPE,
    });
  } catch (err) {
    console.error('[PhoneRadio] presence registration failed:', err);
    return res.status(500).json({ error: 'Failed to register phone radio presence' });
  }
});

export default router;
