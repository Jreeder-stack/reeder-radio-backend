import express from 'express';
import pool from '../db/index.js';
import { requireAdmin } from '../middleware/auth.js';

const router = express.Router();
router.use(requireAdmin);

let schemaReady = false;
let schemaPromise = null;
let catalogCache = { expiresAt: 0, centers: [] };

async function ensureDispatchCenterSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS dispatch_center_id VARCHAR(64)`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS dispatch_center_name VARCHAR(255)`);
      await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS dispatch_center_code VARCHAR(32)`);
      await client.query(`ALTER TABLE radios ADD COLUMN IF NOT EXISTS dispatch_center_id VARCHAR(64)`);
      await client.query(`ALTER TABLE radios ADD COLUMN IF NOT EXISTS dispatch_center_name VARCHAR(255)`);
      await client.query(`ALTER TABLE radios ADD COLUMN IF NOT EXISTS dispatch_center_code VARCHAR(32)`);
      await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS dispatch_center_id VARCHAR(64)`);
      await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS dispatch_center_name VARCHAR(255)`);
      await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS dispatch_center_code VARCHAR(32)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_dispatch_center_id ON users(dispatch_center_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_radios_dispatch_center_id ON radios(dispatch_center_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_units_dispatch_center_id ON units(dispatch_center_id)`);

      // A physical radio assigned to a user always inherits the user's center.
      // Unassigned radios may retain a direct center assignment of their own.
      await client.query(`
        CREATE OR REPLACE FUNCTION sync_radio_dispatch_center_from_user()
        RETURNS trigger AS $$
        DECLARE matched_user RECORD;
        BEGIN
          IF NEW.assigned_unit_id IS NOT NULL THEN
            SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code
            INTO matched_user
            FROM users
            WHERE id = NEW.assigned_unit_id;

            IF FOUND THEN
              NEW.dispatch_center_id := matched_user.dispatch_center_id;
              NEW.dispatch_center_name := matched_user.dispatch_center_name;
              NEW.dispatch_center_code := matched_user.dispatch_center_code;
            END IF;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS trg_radios_dispatch_center_sync ON radios`);
      await client.query(`
        CREATE TRIGGER trg_radios_dispatch_center_sync
        BEFORE INSERT OR UPDATE OF assigned_unit_id ON radios
        FOR EACH ROW EXECUTE FUNCTION sync_radio_dispatch_center_from_user()
      `);

      // Keep live presence rows tied to either the authoritative radio user or,
      // for unassigned hardware, the physical radio's direct center assignment.
      // Unit IDs remain globally unique during this first routing phase.
      await client.query(`
        CREATE OR REPLACE FUNCTION sync_unit_dispatch_center_from_owner()
        RETURNS trigger AS $$
        DECLARE matched_owner RECORD;
        BEGIN
          SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code
          INTO matched_owner
          FROM users
          WHERE unit_id = NEW.unit_identity
          ORDER BY id
          LIMIT 1;

          IF NOT FOUND THEN
            SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code
            INTO matched_owner
            FROM radios
            WHERE radio_id = NEW.unit_identity
            ORDER BY id
            LIMIT 1;
          END IF;

          IF FOUND THEN
            NEW.dispatch_center_id := matched_owner.dispatch_center_id;
            NEW.dispatch_center_name := matched_owner.dispatch_center_name;
            NEW.dispatch_center_code := matched_owner.dispatch_center_code;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS trg_units_dispatch_center_sync ON units`);
      await client.query(`
        CREATE TRIGGER trg_units_dispatch_center_sync
        BEFORE INSERT OR UPDATE OF unit_identity ON units
        FOR EACH ROW EXECUTE FUNCTION sync_unit_dispatch_center_from_owner()
      `);

      await client.query(`
        UPDATE radios r
        SET dispatch_center_id = u.dispatch_center_id,
            dispatch_center_name = u.dispatch_center_name,
            dispatch_center_code = u.dispatch_center_code
        FROM users u
        WHERE r.assigned_unit_id = u.id
      `);
      await client.query(`
        UPDATE units live
        SET dispatch_center_id = u.dispatch_center_id,
            dispatch_center_name = u.dispatch_center_name,
            dispatch_center_code = u.dispatch_center_code
        FROM users u
        WHERE u.unit_id = live.unit_identity
      `);
      await client.query(`
        UPDATE units live
        SET dispatch_center_id = r.dispatch_center_id,
            dispatch_center_name = r.dispatch_center_name,
            dispatch_center_code = r.dispatch_center_code
        FROM radios r
        WHERE r.assigned_unit_id IS NULL
          AND r.radio_id = live.unit_identity
      `);

      await client.query('COMMIT');
      schemaReady = true;
      console.log('[DISPATCH-CENTER] Assignment schema ready');
    } catch (error) {
      await client.query('ROLLBACK');
      schemaPromise = null;
      throw error;
    } finally {
      client.release();
    }
  })();

  return schemaPromise;
}

function cadConfig() {
  return {
    url: String(process.env.CAD_URL || '').replace(/\/$/, ''),
    apiKey: process.env.CAD_API_KEY || '',
  };
}

async function fetchCadDispatchCenters({ force = false } = {}) {
  const now = Date.now();
  if (!force && catalogCache.expiresAt > now) return catalogCache.centers;

  const { url, apiKey } = cadConfig();
  if (!url || !apiKey) {
    const error = new Error('CAD integration is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(`${url}/api/radio/dispatch-centers`, {
    headers: {
      'X-API-Key': apiKey,
      'Accept': 'application/json',
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `CAD returned HTTP ${response.status}`);
    error.statusCode = response.status;
    throw error;
  }

  const centers = Array.isArray(body.dispatchCenters) ? body.dispatchCenters : [];
  catalogCache = { centers, expiresAt: now + 60_000 };
  return centers;
}

async function resolveSelectedCenter(requestedId) {
  if (!requestedId) return null;
  const centers = await fetchCadDispatchCenters();
  const selected = centers.find((center) => center.id === requestedId);
  if (!selected) {
    const error = new Error('Dispatch center was not found in Command Link');
    error.statusCode = 400;
    throw error;
  }
  return selected;
}

router.get('/catalog', async (req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const centers = await fetchCadDispatchCenters({ force: req.query.refresh === 'true' });
    res.json({ dispatchCenters: centers });
  } catch (error) {
    console.error('[DISPATCH-CENTER] Catalog error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to load dispatch centers' });
  }
});

router.get('/users', async (_req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const result = await pool.query(`
      SELECT id, username, email, role, unit_id, status, is_dispatcher,
             dispatch_center_id, dispatch_center_name, dispatch_center_code,
             created_at, last_login
      FROM users
      ORDER BY COALESCE(unit_id, username), username
    `);
    res.json({ users: result.rows });
  } catch (error) {
    console.error('[DISPATCH-CENTER] List user assignments error:', error);
    res.status(500).json({ error: 'Failed to list radio user assignments' });
  }
});

router.get('/radios', async (_req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const result = await pool.query(`
      SELECT r.id, r.radio_id, r.serial_number, r.imei, r.assigned_unit_id,
             r.is_locked, r.last_seen,
             r.dispatch_center_id, r.dispatch_center_name, r.dispatch_center_code,
             u.username AS assigned_username, u.unit_id AS assigned_unit_identity,
             u.dispatch_center_id AS inherited_dispatch_center_id,
             u.dispatch_center_name AS inherited_dispatch_center_name,
             u.dispatch_center_code AS inherited_dispatch_center_code
      FROM radios r
      LEFT JOIN users u ON u.id = r.assigned_unit_id
      ORDER BY r.radio_id
    `);
    res.json({ radios: result.rows });
  } catch (error) {
    console.error('[DISPATCH-CENTER] List physical radio assignments error:', error);
    res.status(500).json({ error: 'Failed to list physical radio assignments' });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const userId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const selected = await resolveSelectedCenter(req.body?.dispatch_center_id || null);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE users
         SET dispatch_center_id = $1,
             dispatch_center_name = $2,
             dispatch_center_code = $3
         WHERE id = $4
         RETURNING id, username, email, role, unit_id, status, is_dispatcher,
                   dispatch_center_id, dispatch_center_name, dispatch_center_code`,
        [selected?.id || null, selected?.name || null, selected?.code || null, userId]
      );

      if (!updated.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Radio user not found' });
      }

      const assignedUser = updated.rows[0];
      await client.query(
        `UPDATE radios
         SET dispatch_center_id = $1,
             dispatch_center_name = $2,
             dispatch_center_code = $3
         WHERE assigned_unit_id = $4`,
        [selected?.id || null, selected?.name || null, selected?.code || null, userId]
      );

      if (assignedUser.unit_id) {
        await client.query(
          `UPDATE units
           SET dispatch_center_id = $1,
               dispatch_center_name = $2,
               dispatch_center_code = $3
           WHERE unit_identity = $4`,
          [selected?.id || null, selected?.name || null, selected?.code || null, assignedUser.unit_id]
        );
      }

      await client.query(
        `INSERT INTO activity_logs (user_id, username, action, details)
         VALUES ($1, $2, 'admin_assign_dispatch_center', $3)`,
        [req.session.user.id, req.session.user.username, JSON.stringify({
          targetType: 'user',
          targetUserId: assignedUser.id,
          targetUnitId: assignedUser.unit_id,
          dispatchCenterId: selected?.id || null,
          dispatchCenterName: selected?.name || null,
        })]
      );
      await client.query('COMMIT');
      res.json({ user: assignedUser });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[DISPATCH-CENTER] Save user assignment error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to save dispatch center assignment' });
  }
});

router.put('/radios/:id', async (req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const radioId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(radioId)) {
      return res.status(400).json({ error: 'Invalid physical radio ID' });
    }

    const selected = await resolveSelectedCenter(req.body?.dispatch_center_id || null);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT r.*, u.dispatch_center_id AS user_dispatch_center_id,
                u.dispatch_center_name AS user_dispatch_center_name
         FROM radios r
         LEFT JOIN users u ON u.id = r.assigned_unit_id
         WHERE r.id = $1
         FOR UPDATE`,
        [radioId]
      );
      const radio = current.rows[0];
      if (!radio) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Physical radio not found' });
      }
      if (radio.assigned_unit_id) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `This radio inherits its dispatch center from assigned unit ${radio.assigned_unit_id}. Update the radio user instead.`,
        });
      }

      const updated = await client.query(
        `UPDATE radios
         SET dispatch_center_id = $1,
             dispatch_center_name = $2,
             dispatch_center_code = $3
         WHERE id = $4
         RETURNING id, radio_id, serial_number, imei, assigned_unit_id, is_locked,
                   dispatch_center_id, dispatch_center_name, dispatch_center_code, last_seen`,
        [selected?.id || null, selected?.name || null, selected?.code || null, radioId]
      );
      const assignedRadio = updated.rows[0];

      await client.query(
        `UPDATE units
         SET dispatch_center_id = $1,
             dispatch_center_name = $2,
             dispatch_center_code = $3
         WHERE unit_identity = $4`,
        [selected?.id || null, selected?.name || null, selected?.code || null, assignedRadio.radio_id]
      );

      await client.query(
        `INSERT INTO activity_logs (user_id, username, action, details)
         VALUES ($1, $2, 'admin_assign_dispatch_center', $3)`,
        [req.session.user.id, req.session.user.username, JSON.stringify({
          targetType: 'physical_radio',
          targetRadioId: assignedRadio.radio_id,
          dispatchCenterId: selected?.id || null,
          dispatchCenterName: selected?.name || null,
        })]
      );
      await client.query('COMMIT');
      res.json({ radio: assignedRadio });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('[DISPATCH-CENTER] Save physical radio assignment error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to save physical radio assignment' });
  }
});

router.post('/sync-live-units', async (_req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const userResult = await pool.query(`
      UPDATE units live
      SET dispatch_center_id = u.dispatch_center_id,
          dispatch_center_name = u.dispatch_center_name,
          dispatch_center_code = u.dispatch_center_code
      FROM users u
      WHERE u.unit_id = live.unit_identity
      RETURNING live.id
    `);
    const radioResult = await pool.query(`
      UPDATE units live
      SET dispatch_center_id = r.dispatch_center_id,
          dispatch_center_name = r.dispatch_center_name,
          dispatch_center_code = r.dispatch_center_code
      FROM radios r
      WHERE r.assigned_unit_id IS NULL
        AND r.radio_id = live.unit_identity
      RETURNING live.id
    `);
    res.json({
      success: true,
      updated: (userResult.rowCount || 0) + (radioResult.rowCount || 0),
      userUnitsUpdated: userResult.rowCount || 0,
      standaloneRadiosUpdated: radioResult.rowCount || 0,
    });
  } catch (error) {
    console.error('[DISPATCH-CENTER] Live unit sync error:', error);
    res.status(500).json({ error: 'Failed to sync live units' });
  }
});

export default router;
