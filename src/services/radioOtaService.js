import crypto from 'crypto';
import pool from '../db/index.js';

let schemaReady = false;
let schemaPromise = null;

export async function ensureRadioOtaSchema() {
  if (schemaReady) return;
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS radio_ota_releases (
        id BIGSERIAL PRIMARY KEY,
        version_code INTEGER NOT NULL UNIQUE,
        version_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        apk_bytes BYTEA NOT NULL,
        apk_size BIGINT NOT NULL,
        notes TEXT,
        created_by BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT TRUE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS radio_ota_assignments (
        id BIGSERIAL PRIMARY KEY,
        release_id BIGINT NOT NULL REFERENCES radio_ota_releases(id) ON DELETE CASCADE,
        radio_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        detail TEXT,
        current_version_code INTEGER,
        pushed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        downloaded_at TIMESTAMPTZ,
        installed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(release_id, radio_id)
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS radio_ota_assignments_radio_idx ON radio_ota_assignments(radio_id, updated_at DESC)`);
    schemaReady = true;
  })().finally(() => { schemaPromise = null; });
  return schemaPromise;
}

export function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function createOtaRelease({ versionCode, versionName, notes = null, apkBytes, createdBy = null }) {
  await ensureRadioOtaSchema();
  if (!Buffer.isBuffer(apkBytes) || apkBytes.length < 1024) {
    throw new Error('APK payload is missing or too small');
  }
  const sha256 = sha256Buffer(apkBytes);
  const result = await pool.query(
    `INSERT INTO radio_ota_releases
       (version_code, version_name, sha256, apk_bytes, apk_size, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (version_code) DO UPDATE SET
       version_name = EXCLUDED.version_name,
       sha256 = EXCLUDED.sha256,
       apk_bytes = EXCLUDED.apk_bytes,
       apk_size = EXCLUDED.apk_size,
       notes = EXCLUDED.notes,
       created_by = EXCLUDED.created_by,
       created_at = NOW(),
       is_active = TRUE
     RETURNING id, version_code, version_name, sha256, apk_size, notes, created_at, is_active`,
    [versionCode, versionName, sha256, apkBytes, apkBytes.length, notes, createdBy]
  );
  return result.rows[0];
}

export async function listOtaReleases(limit = 20) {
  await ensureRadioOtaSchema();
  const result = await pool.query(
    `SELECT r.id, r.version_code, r.version_name, r.sha256, r.apk_size, r.notes,
            r.created_at, r.is_active,
            COUNT(a.id)::int AS assigned_count,
            COUNT(a.id) FILTER (WHERE a.status = 'installed')::int AS installed_count,
            COUNT(a.id) FILTER (WHERE a.status = 'failed')::int AS failed_count
       FROM radio_ota_releases r
       LEFT JOIN radio_ota_assignments a ON a.release_id = r.id
      GROUP BY r.id
      ORDER BY r.version_code DESC
      LIMIT $1`,
    [Math.max(1, Math.min(Number(limit) || 20, 100))]
  );
  return result.rows;
}

export async function getOtaRelease(releaseId, includeBytes = false) {
  await ensureRadioOtaSchema();
  const columns = includeBytes
    ? 'id, version_code, version_name, sha256, apk_size, notes, created_at, is_active, apk_bytes'
    : 'id, version_code, version_name, sha256, apk_size, notes, created_at, is_active';
  const result = await pool.query(`SELECT ${columns} FROM radio_ota_releases WHERE id = $1 AND is_active = TRUE`, [releaseId]);
  return result.rows[0] || null;
}

export async function assignReleaseToRadios(releaseId, radioIds) {
  await ensureRadioOtaSchema();
  const ids = [...new Set((radioIds || []).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const values = [];
  const tuples = ids.map((radioId, i) => {
    values.push(releaseId, radioId);
    const n = i * 2;
    return `($${n + 1}, $${n + 2}, 'queued', NOW(), NOW())`;
  });
  const result = await pool.query(
    `INSERT INTO radio_ota_assignments (release_id, radio_id, status, pushed_at, updated_at)
     VALUES ${tuples.join(',')}
     ON CONFLICT (release_id, radio_id) DO UPDATE SET
       status = CASE WHEN radio_ota_assignments.status = 'installed' THEN 'installed' ELSE 'queued' END,
       detail = NULL,
       pushed_at = NOW(),
       updated_at = NOW()
     RETURNING *`,
    values
  );
  return result.rows;
}

export async function getPendingOtaForRadio(radioId, currentVersionCode = 0) {
  await ensureRadioOtaSchema();
  const result = await pool.query(
    `SELECT a.id AS assignment_id, a.status, r.id AS release_id, r.version_code, r.version_name,
            r.sha256, r.apk_size, r.notes, r.created_at
       FROM radio_ota_assignments a
       JOIN radio_ota_releases r ON r.id = a.release_id
      WHERE a.radio_id = $1
        AND r.is_active = TRUE
        AND r.version_code > $2
        AND a.status <> 'installed'
      ORDER BY r.version_code DESC
      LIMIT 1`,
    [radioId, Number(currentVersionCode) || 0]
  );
  return result.rows[0] || null;
}

export async function updateOtaStatus({ radioId, releaseId, status, detail = null, currentVersionCode = null }) {
  await ensureRadioOtaSchema();
  const allowed = new Set(['queued', 'deferred', 'downloading', 'downloaded', 'installing', 'installed', 'failed']);
  if (!allowed.has(status)) throw new Error('Invalid OTA status');
  const result = await pool.query(
    `UPDATE radio_ota_assignments
        SET status = $3,
            detail = $4,
            current_version_code = COALESCE($5, current_version_code),
            downloaded_at = CASE WHEN $3 IN ('downloaded','installing','installed') AND downloaded_at IS NULL THEN NOW() ELSE downloaded_at END,
            installed_at = CASE WHEN $3 = 'installed' THEN NOW() ELSE installed_at END,
            updated_at = NOW()
      WHERE radio_id = $1 AND release_id = $2
      RETURNING *`,
    [radioId, releaseId, status, detail, currentVersionCode]
  );
  return result.rows[0] || null;
}

export async function getOtaAssignmentSummary(releaseId) {
  await ensureRadioOtaSchema();
  const result = await pool.query(
    `SELECT a.radio_id, a.status, a.detail, a.current_version_code, a.pushed_at,
            a.downloaded_at, a.installed_at, a.updated_at,
            r.version_code, r.version_name
       FROM radio_ota_assignments a
       JOIN radio_ota_releases r ON r.id = a.release_id
      WHERE a.release_id = $1
      ORDER BY a.updated_at DESC`,
    [releaseId]
  );
  return result.rows;
}
