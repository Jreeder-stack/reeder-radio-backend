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
      await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS dispatch_center_id VARCHAR(64)`);
      await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS dispatch_center_name VARCHAR(255)`);
      await client.query(`ALTER TABLE units ADD COLUMN IF NOT EXISTS dispatch_center_code VARCHAR(32)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_users_dispatch_center_id ON users(dispatch_center_id)`);
      await client.query(`CREATE INDEX IF NOT EXISTS idx_units_dispatch_center_id ON units(dispatch_center_id)`);

      // Keep live presence rows tied to the authoritative radio user record.
      // The current system still requires unit_id to be globally unique, so
      // unit_identity is unambiguous during this first migration phase.
      await client.query(`
        CREATE OR REPLACE FUNCTION sync_unit_dispatch_center_from_user()
        RETURNS trigger AS $$
        DECLARE matched_user RECORD;
        BEGIN
          SELECT dispatch_center_id, dispatch_center_name, dispatch_center_code
          INTO matched_user
          FROM users
          WHERE unit_id = NEW.unit_identity
          ORDER BY id
          LIMIT 1;

          IF FOUND THEN
            NEW.dispatch_center_id := matched_user.dispatch_center_id;
            NEW.dispatch_center_name := matched_user.dispatch_center_name;
            NEW.dispatch_center_code := matched_user.dispatch_center_code;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await client.query(`DROP TRIGGER IF EXISTS trg_units_dispatch_center_sync ON units`);
      await client.query(`
        CREATE TRIGGER trg_units_dispatch_center_sync
        BEFORE INSERT OR UPDATE OF unit_identity ON units
        FOR EACH ROW EXECUTE FUNCTION sync_unit_dispatch_center_from_user()
      `);

      await client.query(`
        UPDATE units live
        SET dispatch_center_id = u.dispatch_center_id,
            dispatch_center_name = u.dispatch_center_name,
            dispatch_center_code = u.dispatch_center_code
        FROM users u
        WHERE u.unit_id = live.unit_identity
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
    console.error('[DISPATCH-CENTER] List assignments error:', error);
    res.status(500).json({ error: 'Failed to list radio assignments' });
  }
});

router.put('/users/:id', async (req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const userId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const requestedId = req.body?.dispatch_center_id || null;
    let selected = null;
    if (requestedId) {
      const centers = await fetchCadDispatchCenters();
      selected = centers.find((center) => center.id === requestedId);
      if (!selected) {
        return res.status(400).json({ error: 'Dispatch center was not found in Command Link' });
      }
    }

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
    console.error('[DISPATCH-CENTER] Save assignment error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Failed to save dispatch center assignment' });
  }
});

router.post('/sync-live-units', async (_req, res) => {
  try {
    await ensureDispatchCenterSchema();
    const result = await pool.query(`
      UPDATE units live
      SET dispatch_center_id = u.dispatch_center_id,
          dispatch_center_name = u.dispatch_center_name,
          dispatch_center_code = u.dispatch_center_code
      FROM users u
      WHERE u.unit_id = live.unit_identity
      RETURNING live.id
    `);
    res.json({ success: true, updated: result.rowCount || 0 });
  } catch (error) {
    console.error('[DISPATCH-CENTER] Live unit sync error:', error);
    res.status(500).json({ error: 'Failed to sync live units' });
  }
});

export default router;
