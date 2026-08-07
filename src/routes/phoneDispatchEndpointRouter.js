import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getPage, recordPageAck } from '../db/index.js';
import pool from '../db/index.js';

const router = express.Router();

function getPhoneDeviceId(req) {
  const deviceType = String(req.headers['x-command-device-type'] || '').trim().toLowerCase();
  const deviceId = String(req.headers['x-command-device-id'] || '').trim().toLowerCase();
  if (deviceType !== 'android_phone' || !deviceId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deviceId)) return null;
  return deviceId;
}

/**
 * Attribute a phone page acknowledgment to the exact physical phone endpoint.
 * The legacy session fallback picks the most recently seen radio assigned to a
 * user, which is ambiguous when the same unit has a T320 and a phone.
 */
router.post('/page/:id/ack', requireAuth, async (req, res, next) => {
  const deviceId = getPhoneDeviceId(req);
  if (!deviceId) return next();

  const pageId = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(pageId)) return res.status(400).json({ error: 'Invalid page ID' });

  try {
    const page = await getPage(pageId);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    const result = await pool.query(
      `SELECT radio_id, assigned_unit_id
         FROM radios
        WHERE device_uuid = $1::uuid
          AND assigned_unit_id = $2
        LIMIT 1`,
      [deviceId, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Phone radio endpoint is not registered' });
    }

    const radio = result.rows[0];
    const ack = await recordPageAck(pageId, radio.assigned_unit_id, radio.radio_id);
    return res.json({ success: true, ack });
  } catch (err) {
    console.error('[PhoneRadio] Page ACK error:', err);
    return res.status(500).json({ error: 'Failed to record phone page acknowledgment' });
  }
});

export default router;
