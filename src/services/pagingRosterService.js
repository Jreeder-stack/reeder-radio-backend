import pool from '../db/index.js';

let initialized = false;

export async function ensurePagingRosterSchema() {
  if (initialized) return;

  await pool.query(`ALTER TABLE radios ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatcher_paging_lists (
      id SERIAL PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dispatcher_paging_list_members (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES dispatcher_paging_lists(id) ON DELETE CASCADE,
      radio_id INTEGER NOT NULL REFERENCES radios(id) ON DELETE CASCADE,
      added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(list_id, radio_id)
    )
  `);

  initialized = true;
}

export async function getActivatedRadioRoster() {
  await ensurePagingRosterSchema();
  const result = await pool.query(`
    SELECT
      r.id AS radio_pk,
      r.radio_id,
      r.is_active,
      r.is_locked,
      r.last_seen AS radio_last_seen,
      r.assigned_unit_id,
      u.unit_id,
      u.username,
      p.channel,
      p.status AS presence_status,
      p.last_seen AS presence_last_seen,
      p.is_emergency
    FROM radios r
    LEFT JOIN users u ON u.id = r.assigned_unit_id
    LEFT JOIN units p ON p.unit_identity = COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id)
    WHERE r.is_active = true
    ORDER BY COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id)
  `);
  return result.rows;
}

export async function getDispatcherPagingLists() {
  await ensurePagingRosterSchema();

  const custom = await pool.query(`
    SELECT
      l.id,
      l.name,
      'custom'::text AS kind,
      COALESCE(array_agg(m.radio_id) FILTER (WHERE m.radio_id IS NOT NULL), '{}') AS member_radio_ids
    FROM dispatcher_paging_lists l
    LEFT JOIN dispatcher_paging_list_members m ON m.list_id = l.id
    GROUP BY l.id, l.name
    ORDER BY lower(l.name)
  `);

  const system = await pool.query(`
    SELECT
      pl.id,
      pl.label AS name,
      'system'::text AS kind,
      pl.list_type,
      COALESCE(array_agg(DISTINCT r.id) FILTER (WHERE r.id IS NOT NULL), '{}') AS member_radio_ids
    FROM paging_lists pl
    LEFT JOIN paging_list_members pm ON pm.list_id = pl.id
    LEFT JOIN radios r ON r.assigned_unit_id = pm.user_id AND COALESCE(r.is_active, true) = true
    GROUP BY pl.id, pl.label, pl.list_type
    ORDER BY pl.id
  `);

  return [
    ...system.rows.map(row => ({
      id: `system:${row.list_type}`,
      name: row.name,
      kind: 'system',
      listType: row.list_type,
      memberRadioIds: row.member_radio_ids.map(Number),
      protected: true,
    })),
    ...custom.rows.map(row => ({
      id: String(row.id),
      name: row.name,
      kind: 'custom',
      memberRadioIds: row.member_radio_ids.map(Number),
      protected: false,
    })),
  ];
}

async function replaceCustomListMembers(client, listId, radioIds) {
  const cleanIds = [...new Set((radioIds || []).map(Number).filter(Number.isInteger))];
  await client.query('DELETE FROM dispatcher_paging_list_members WHERE list_id = $1', [listId]);
  if (cleanIds.length === 0) return;

  await client.query(
    `INSERT INTO dispatcher_paging_list_members (list_id, radio_id)
     SELECT $1, id FROM radios WHERE id = ANY($2::int[]) AND COALESCE(is_active, true) = true
     ON CONFLICT (list_id, radio_id) DO NOTHING`,
    [listId, cleanIds]
  );
}

export async function createDispatcherPagingList(name, radioIds, createdBy) {
  await ensurePagingRosterSchema();
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new Error('List name is required');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO dispatcher_paging_lists (name, created_by) VALUES ($1, $2) RETURNING id, name`,
      [trimmed, createdBy || null]
    );
    await replaceCustomListMembers(client, created.rows[0].id, radioIds);
    await client.query('COMMIT');
    return created.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateDispatcherPagingList(id, name, radioIds) {
  await ensurePagingRosterSchema();
  const listId = Number(id);
  if (!Number.isInteger(listId)) throw new Error('Invalid list ID');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (name !== undefined) {
      const trimmed = String(name || '').trim();
      if (!trimmed) throw new Error('List name is required');
      await client.query(
        `UPDATE dispatcher_paging_lists SET name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
        [trimmed, listId]
      );
    }
    if (radioIds !== undefined) {
      await replaceCustomListMembers(client, listId, radioIds);
      await client.query(
        `UPDATE dispatcher_paging_lists SET updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [listId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteDispatcherPagingList(id) {
  await ensurePagingRosterSchema();
  const result = await pool.query(
    `DELETE FROM dispatcher_paging_lists WHERE id = $1 RETURNING id`,
    [Number(id)]
  );
  return result.rowCount > 0;
}

export async function resolveRadioRecipients({ radioIds, listId }) {
  await ensurePagingRosterSchema();

  let selectedRadioIds = (radioIds || []).map(Number).filter(Number.isInteger);

  if (listId) {
    const value = String(listId);
    if (value.startsWith('system:')) {
      const listType = value.slice('system:'.length);
      const result = await pool.query(`
        SELECT DISTINCT r.id
        FROM paging_lists pl
        JOIN paging_list_members pm ON pm.list_id = pl.id
        JOIN radios r ON r.assigned_unit_id = pm.user_id
        WHERE pl.list_type = $1 AND COALESCE(r.is_active, true) = true
      `, [listType]);
      selectedRadioIds = result.rows.map(row => Number(row.id));
    } else {
      const result = await pool.query(
        `SELECT radio_id FROM dispatcher_paging_list_members WHERE list_id = $1`,
        [Number(value)]
      );
      selectedRadioIds = result.rows.map(row => Number(row.radio_id));
    }
  }

  selectedRadioIds = [...new Set(selectedRadioIds)];
  if (selectedRadioIds.length === 0) return [];

  const result = await pool.query(`
    SELECT
      r.id AS radio_pk,
      r.radio_id,
      r.fcm_token,
      r.assigned_unit_id,
      COALESCE(NULLIF(u.unit_id, ''), u.username, r.radio_id) AS unit_identity,
      ap.token AS apns_token
    FROM radios r
    LEFT JOIN users u ON u.id = r.assigned_unit_id
    LEFT JOIN apns_tokens ap ON ap.user_id = r.assigned_unit_id
    WHERE r.id = ANY($1::int[]) AND COALESCE(r.is_active, true) = true
    ORDER BY unit_identity, r.radio_id
  `, [selectedRadioIds]);

  const byRadio = new Map();
  for (const row of result.rows) {
    const key = Number(row.radio_pk);
    if (!byRadio.has(key)) {
      byRadio.set(key, {
        radioPk: key,
        radioId: row.radio_id,
        unitId: row.unit_identity,
        fcmTokens: [],
        apnsTokens: [],
      });
    }
    const item = byRadio.get(key);
    if (row.fcm_token && !item.fcmTokens.includes(row.fcm_token)) item.fcmTokens.push(row.fcm_token);
    if (row.apns_token && !item.apnsTokens.includes(row.apns_token)) item.apnsTokens.push(row.apns_token);
  }

  return Array.from(byRadio.values());
}
