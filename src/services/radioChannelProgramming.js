import pool from '../db/index.js';

/** A radio's custom program may narrow, never expand, its unit's permissions. */
export function filterRadioChannels(authorizedChannels, programming) {
  if (!programming?.custom) return authorizedChannels;
  const byId = new Map(authorizedChannels.map(ch => [Number(ch.id), ch]));
  return programming.channelIds.map(id => byId.get(Number(id))).filter(Boolean);
}

export function validateRadioChannelIds(ids, allowedChannels) {
  if (ids === null) return null;
  if (!Array.isArray(ids) || ids.length > 256)
    throw new TypeError('channelIds must be null or an array of at most 256 IDs');
  const allowed = new Set(allowedChannels.map(c => Number(c.id)));
  const used = new Set();
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0 || used.has(id) || !allowed.has(id))
      throw new TypeError('Channel IDs must be unique and assigned to the selected unit');
    used.add(id);
  }
  return ids;
}

export async function readRadioProgramming(radioId, custom, executor = pool) {
  if (!custom) return { custom: false, channelIds: [] };
  const result = await executor.query(
    'SELECT channel_id FROM radio_channel_programming WHERE radio_id = $1 ORDER BY sort_order',
    [radioId]
  );
  return { custom: true, channelIds: result.rows.map(r => Number(r.channel_id)) };
}

export async function replaceRadioProgramming(radioId, expectedUnitId, ids, executor = pool) {
  const client = await executor.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(
      'SELECT assigned_unit_id FROM radios WHERE radio_id = $1 FOR UPDATE', [radioId]
    );
    if (!current.rows.length || current.rows[0].assigned_unit_id == null ||
        String(current.rows[0].assigned_unit_id) !== String(expectedUnitId)) {
      const err = new Error('Radio assignment changed; reload before programming');
      err.code = 'RADIO_ASSIGNMENT_CHANGED';
      throw err;
    }
    await client.query('DELETE FROM radio_channel_programming WHERE radio_id = $1', [radioId]);
    for (const [position, id] of (ids || []).entries()) {
      await client.query(
        'INSERT INTO radio_channel_programming (radio_id, channel_id, sort_order) VALUES ($1, $2, $3)',
        [radioId, id, position]
      );
    }
    await client.query(
      'UPDATE radios SET custom_channel_programming = $2 WHERE radio_id = $1',
      [radioId, ids !== null]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
