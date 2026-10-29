import pool, { recordPageAck } from '../db/index.js';

// Durable, expiring per-device deliveries. Never trust a client-supplied unit or radio ID.
const TTL_MS = 600_000;
let schemaReady = null;
async function ensureSchema() {
  if (!schemaReady) schemaReady = pool.query([
    'CREATE TABLE IF NOT EXISTS native_page_deliveries (',
    'page_id BIGINT NOT NULL, radio_id TEXT NOT NULL, message TEXT NOT NULL,',
    'sender TEXT NOT NULL, paging_channel_id TEXT, expires_at TIMESTAMPTZ NOT NULL,',
    'sent_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ,',
    'attempts INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (page_id, radio_id))'
  ].join(' ')).catch(err => { schemaReady = null; throw err; });
  await schemaReady;
}

export function nativeRadioSocket(socket, radioId) {
  return !!(socket?.isRadioDevice && !socket.radioTokenPending && socket.radioId &&
    String(socket.radioId) === String(radioId) && socket.connected !== false);
}

export function nativePageStatus(row, now = Date.now()) {
  if (row.acknowledged_at) return 'acknowledged';
  if (row.delivered_at) return 'delivered';
  if (new Date(row.expires_at).getTime() <= now) return 'expired';
  if (row.sent_at) return 'pending';
  return 'queued';
}

async function sendPending(socket) {
  if (!nativeRadioSocket(socket, socket?.radioId)) return 0;
  await ensureSchema();
  const result = await pool.query([
    'SELECT * FROM native_page_deliveries WHERE radio_id = $1',
    'AND delivered_at IS NULL AND acknowledged_at IS NULL AND expires_at > NOW()',
    'ORDER BY page_id LIMIT 30'
  ].join(' '), [socket.radioId]);
  let count = 0;
  for (const row of result.rows) {
    if (!nativeRadioSocket(socket, row.radio_id)) break;
    socket.emit('radio:page', {
      pageId: String(row.page_id), message: row.message, sender: row.sender,
      pagingChannelId: row.paging_channel_id || '',
      expiresAt: new Date(row.expires_at).getTime()
    });
    count++;
    await pool.query([
      'UPDATE native_page_deliveries SET sent_at = NOW(), attempts = attempts + 1',
      'WHERE page_id = $1 AND radio_id = $2 AND acknowledged_at IS NULL'
    ].join(' '), [row.page_id, row.radio_id]);
  }
  return count;
}

export async function queueNativePage(signaling, page, recipients, pagingChannelId) {
  await ensureSchema();
  const expiresAt = new Date(Date.now() + TTL_MS);
  // Native signaling is the fallback for radios without FCM/APNs.
  for (const radio of recipients) {
    if (radio.fcmTokens?.length || radio.apnsTokens?.length) continue;
    await pool.query([
      'INSERT INTO native_page_deliveries',
      '(page_id, radio_id, message, sender, paging_channel_id, expires_at)',
      'VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (page_id, radio_id) DO NOTHING'
    ].join(' '), [page.id, radio.radioId, page.message, page.sender,
      pagingChannelId == null ? null : String(pagingChannelId), expiresAt]);
  }
  let sent = 0;
  for (const socket of signaling?.io?.sockets?.sockets?.values() || []) {
    if (recipients.some(r => String(r.radioId) === String(socket.radioId) &&
      !r.fcmTokens?.length && !r.apnsTokens?.length)) {
      sent += await sendPending(socket);
    }
  }
  return sent;
}

export async function replayNativePages(socket) {
  return sendPending(socket);
}

export async function recordNativePageReceipt(socket, data) {
  if (!nativeRadioSocket(socket, socket?.radioId)) return false;
  const pageId = Number(data?.pageId);
  if (!Number.isSafeInteger(pageId) || pageId <= 0 ||
      !['delivered', 'acknowledged'].includes(data?.kind)) return false;
  await ensureSchema();
  const field = data.kind === 'acknowledged' ? 'acknowledged_at' : 'delivered_at';
  const result = await pool.query(
    'UPDATE native_page_deliveries SET ' + field + ' = COALESCE(' + field + ', NOW()) ' +
    'WHERE page_id = $1 AND radio_id = $2 AND expires_at > NOW() RETURNING page_id',
    [pageId, socket.radioId]
  );
  if (result.rowCount === 0) return false;
  if (data.kind === 'acknowledged') {
    await recordPageAck(pageId, socket.assignedUnitId || null, socket.radioId);
  }
  return true;
}

export async function nativePageStatuses(pageId) {
  await ensureSchema();
  const r = await pool.query([
    'SELECT radio_id, sent_at, delivered_at, acknowledged_at, expires_at, attempts',
    'FROM native_page_deliveries WHERE page_id = $1 ORDER BY radio_id'
  ].join(' '), [pageId]);
  return r.rows.map(row => ({
    radioId: row.radio_id, status: nativePageStatus(row), attempts: row.attempts,
    deliveredAt: row.delivered_at, acknowledgedAt: row.acknowledged_at
  }));
}
