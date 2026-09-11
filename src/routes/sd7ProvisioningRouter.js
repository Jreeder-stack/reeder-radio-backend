import express from 'express';
import crypto from 'crypto';
import { requireAdmin } from '../middleware/auth.js';
import pool, { getRadioBySerial, createRadio, assignRadioUnit } from '../db/index.js';

const router = express.Router();

/**
 * Pre-register a physical radio from the existing Radio Management page.
 * The normal /api/radios/register endpoint later matches the physical device
 * by serial number and re-issues this row's radio token to the device.
 */
router.post('/pre-register', requireAdmin, async (req, res) => {
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim() : '';
  const imei = typeof req.body?.imei === 'string' ? req.body.imei.trim() : '';
  const unitId = req.body?.unit_id ?? null;

  if (!serial) return res.status(400).json({ error: 'Serial number is required' });
  if (!imei) return res.status(400).json({ error: 'IMEI is required' });

  try {
    let radio = await getRadioBySerial(serial);
    let created = false;

    if (!radio) {
      const token = crypto.randomBytes(32).toString('hex');
      radio = await createRadio(serial, imei, token);
      created = true;
    } else if (!radio.imei || radio.imei !== imei) {
      const updated = await pool.query(
        'UPDATE radios SET imei = $1 WHERE radio_id = $2 RETURNING *',
        [imei, radio.radio_id]
      );
      radio = updated.rows[0] || radio;
    }

    let assignedUnitIdentity = null;
    if (unitId !== null && unitId !== undefined && String(unitId).trim() !== '') {
      const userResult = await pool.query(
        'SELECT id, unit_id, username FROM users WHERE id = $1',
        [unitId]
      );
      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'Assigned unit/user not found' });
      }
      radio = await assignRadioUnit(radio.radio_id, userResult.rows[0].id);
      assignedUnitIdentity = userResult.rows[0].unit_id || userResult.rows[0].username || null;
    }

    return res.status(created ? 201 : 200).json({
      radio: { ...radio, assigned_unit_identity: assignedUnitIdentity },
      created,
      provisioningStatus: radio.last_seen ? 'registered' : 'pending',
      message: created
        ? 'Radio pre-registered. It will claim this record when the physical device reports the matching serial number.'
        : 'Existing radio record updated.',
    });
  } catch (err) {
    console.error('[SD7 Provisioning] pre-register error:', err);
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'That IMEI or serial number is already registered to another radio' });
    }
    return res.status(500).json({ error: 'Could not pre-register radio' });
  }
});

export default router;
