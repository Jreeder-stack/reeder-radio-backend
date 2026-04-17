import pg from 'pg';
import bcrypt from 'bcryptjs';
import { config } from '../config/env.js';

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        email VARCHAR(255),
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        unit_id VARCHAR(50),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dispatcher BOOLEAN DEFAULT false`);

    try {
      const dupeCheck = await client.query(
        `SELECT unit_id, COUNT(*) AS cnt FROM users WHERE unit_id IS NOT NULL AND unit_id != '' GROUP BY unit_id HAVING COUNT(*) > 1`
      );
      if (dupeCheck.rows.length > 0) {
        for (const row of dupeCheck.rows) {
          console.warn(`[DB-INIT] DUPLICATE_UNIT_ID_FOUND unit_id="${row.unit_id}" count=${row.cnt} — cannot create unique index until resolved`);
        }
        console.warn(`[DB-INIT] Skipping unique index on users.unit_id due to ${dupeCheck.rows.length} duplicate(s). Fix duplicates to enable constraint.`);
      } else {
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_users_unit_id_unique
          ON users (unit_id) WHERE unit_id IS NOT NULL AND unit_id != ''
        `);
      }
    } catch (idxErr) {
      console.warn(`[DB-INIT] Could not create unique index on users.unit_id: ${idxErr.message}`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS zones (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        zone VARCHAR(100) NOT NULL,
        zone_id INTEGER REFERENCES zones(id),
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT channels_name_zone_id_unique UNIQUE (name, zone_id)
      )
    `);

    await client.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES zones(id)`);

    try {
      await client.query(`ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_key`);
    } catch (e) {}
    try {
      await client.query(`ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_name_unique`);
    } catch (e) {}
    try {
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'channels_name_zone_id_unique'
          ) THEN
            ALTER TABLE channels ADD CONSTRAINT channels_name_zone_id_unique UNIQUE (name, zone_id);
          END IF;
        END $$
      `);
    } catch (e) {
      console.log('Note: per-zone unique constraint may already exist');
    }

    await client.query(`
      UPDATE channels SET zone_id = z.id
      FROM zones z
      WHERE channels.zone = z.name AND channels.zone_id IS NULL
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_channel_access (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        channel_id INTEGER REFERENCES channels(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, channel_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        username VARCHAR(100),
        action VARCHAR(50) NOT NULL,
        details JSONB,
        channel VARCHAR(50),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL,
        PRIMARY KEY (sid)
      )
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS units (
        id SERIAL PRIMARY KEY,
        unit_identity VARCHAR(100) UNIQUE NOT NULL,
        channel VARCHAR(50),
        status VARCHAR(20) DEFAULT 'idle',
        last_seen TIMESTAMP,
        location JSONB,
        is_emergency BOOLEAN DEFAULT false
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS radio_events (
        id SERIAL PRIMARY KEY,
        unit_identity VARCHAR(100),
        channel VARCHAR(50),
        event_type VARCHAR(50),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        metadata JSONB
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dispatch_monitor_sets (
        id SERIAL PRIMARY KEY,
        dispatcher_id INTEGER REFERENCES users(id) UNIQUE,
        primary_tx_channel VARCHAR(50),
        monitored_channels JSONB DEFAULT '[]'
      )
    `);

    await client.query(`ALTER TABLE dispatch_monitor_sets ADD COLUMN IF NOT EXISTS primary_tx_channel_id INTEGER`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS radio_channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        livekit_room_name VARCHAR(100),
        is_emergency_only BOOLEAN DEFAULT false,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_patches (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100),
        source_channel_id INTEGER REFERENCES radio_channels(id),
        target_channel_id INTEGER REFERENCES radio_channels(id),
        is_enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(255) UNIQUE NOT NULL,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      INSERT INTO ai_settings (key, value) VALUES ('ai_dispatch_enabled', 'false')
      ON CONFLICT (key) DO NOTHING
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id SERIAL PRIMARY KEY,
        channel VARCHAR(50) NOT NULL,
        sender VARCHAR(100) NOT NULL,
        message_type VARCHAR(20) NOT NULL DEFAULT 'text',
        content TEXT,
        audio_url VARCHAR(500),
        audio_duration INTEGER,
        transcription TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await client.query(`CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages (channel)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_channel_messages_created ON channel_messages (created_at DESC)`);

    await client.query(`ALTER TABLE channel_messages ALTER COLUMN channel TYPE VARCHAR(200)`).catch(() => {});

    await client.query(`
      UPDATE channel_messages cm
      SET channel = sub.room_key
      FROM (
        SELECT ch.name, COALESCE(ch.zone, 'Default') || '__' || ch.name AS room_key
        FROM channels ch
        WHERE ch.name IN (
          SELECT DISTINCT cm2.channel FROM channel_messages cm2
          WHERE position('__' in cm2.channel) = 0
        )
        AND NOT EXISTS (
          SELECT 1 FROM channels ch2
          WHERE ch2.name = ch.name AND ch2.id != ch.id
        )
      ) sub
      WHERE cm.channel = sub.name
        AND position('__' in cm.channel) = 0
    `).catch(err => {
      console.warn('[DB] Legacy channel name migration skipped:', err.message);
    });

    await client.query(`ALTER TABLE channel_messages ADD COLUMN IF NOT EXISTS audio_data BYTEA`).catch(() => {});

    try {
      const { default: fs } = await import('fs');
      const { default: path } = await import('path');
      const AUDIO_DIR = path.join(process.cwd(), 'uploads', 'audio');
      if (fs.existsSync(AUDIO_DIR)) {
        const needBackfill = await client.query(
          `SELECT id, audio_url FROM channel_messages WHERE message_type = 'audio' AND audio_data IS NULL AND audio_url IS NOT NULL`
        );
        let migrated = 0;
        for (const row of needBackfill.rows) {
          const filename = row.audio_url.split('/').pop();
          const filepath = path.join(AUDIO_DIR, filename);
          if (fs.existsSync(filepath)) {
            const audioBuffer = fs.readFileSync(filepath);
            await client.query(`UPDATE channel_messages SET audio_data = $1 WHERE id = $2`, [audioBuffer, row.id]);
            migrated++;
          }
        }
        if (migrated > 0) {
          console.log(`[DB] Migrated ${migrated} WAV files from disk into database`);
        }
      }
    } catch (err) {
      console.warn('[DB] Audio data migration from disk skipped:', err.message);
    }

    await client.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS announcement_audio BYTEA`);
    await client.query(`ALTER TABLE zones ADD COLUMN IF NOT EXISTS announcement_audio BYTEA`);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_units_last_seen ON units (last_seen)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs (created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_activity_logs_username ON activity_logs (username)`);

    await client.query(`
      CREATE SEQUENCE IF NOT EXISTS radios_radio_id_seq START 1
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS radios (
        id SERIAL PRIMARY KEY,
        radio_id VARCHAR(6) UNIQUE NOT NULL,
        serial_number VARCHAR(255) UNIQUE NOT NULL,
        imei VARCHAR(20),
        assigned_unit_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        is_locked BOOLEAN DEFAULT false,
        token VARCHAR(255) UNIQUE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP
      )
    `);

    await client.query(`ALTER TABLE radios ADD COLUMN IF NOT EXISTS device_uuid UUID`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_radios_serial_number ON radios (serial_number)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_radios_token ON radios (token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_radios_assigned_unit_id ON radios (assigned_unit_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        unit_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        device_type VARCHAR(20) NOT NULL DEFAULT 'browser',
        device_label VARCHAR(255),
        last_seen TIMESTAMP,
        registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_devices_unit_id ON devices (unit_id)`);

    const existingAdmin = await client.query(
      'SELECT id FROM users WHERE username = $1',
      [config.adminUsername]
    );
    
    if (existingAdmin.rows.length === 0) {
      const hash = await bcrypt.hash(config.adminPassword, 10);
      await client.query(
        'INSERT INTO users (username, password_hash, role, status) VALUES ($1, $2, $3, $4)',
        [config.adminUsername, hash, 'admin', 'active']
      );
      console.log(`Default admin account created: ${config.adminUsername}`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS paging_tones (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        audio_data BYTEA NOT NULL,
        is_active BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      INSERT INTO ai_settings (key, value) VALUES ('paging_channel_id', '')
      ON CONFLICT (key) DO NOTHING
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id SERIAL PRIMARY KEY,
        message TEXT NOT NULL,
        sender VARCHAR(100) NOT NULL,
        target_type VARCHAR(20) NOT NULL,
        target_id VARCHAR(100) NOT NULL,
        sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS page_acks (
        id SERIAL PRIMARY KEY,
        page_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
        unit_id VARCHAR(100),
        radio_id VARCHAR(20),
        acked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(page_id, radio_id)
      )
    `);

    await client.query(`ALTER TABLE radios ADD COLUMN IF NOT EXISTS fcm_token TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_radios_fcm_token ON radios (fcm_token) WHERE fcm_token IS NOT NULL`);

    try {
      const resetResult = await client.query(
        `UPDATE units SET status = 'offline' WHERE status != 'offline' RETURNING unit_identity`
      );
      if (resetResult.rowCount > 0) {
        console.log(`[DB-INIT] Reset ${resetResult.rowCount} stale unit(s) to offline on startup`);
      }
    } catch (resetErr) {
      console.warn(`[DB-INIT] Could not reset stale unit statuses: ${resetErr.message}`);
    }

    console.log('Database initialized successfully');
  } finally {
    client.release();
  }
}

export async function getUser(username) {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  return result.rows[0];
}

export async function getUserById(id) {
  const result = await pool.query(
    'SELECT id, username, role, unit_id, is_dispatcher FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

export async function createUser(username, password, role = 'user', email = null, unit_id = null) {
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash, role, email, unit_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [username, hash, role, email, unit_id]
  );
  return result.rows[0];
}

export async function createUserWithChannels(username, password, role = 'user', email = null, unit_id = null, channelIds = [], is_dispatcher = false) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      'INSERT INTO users (username, password_hash, role, email, unit_id, is_dispatcher) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [username, hash, role, email, unit_id, is_dispatcher]
    );
    const user = userResult.rows[0];

    for (const channelId of channelIds) {
      await client.query(
        'INSERT INTO user_channel_access (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [user.id, channelId]
      );
    }

    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getAllUsers() {
  const result = await pool.query(
    'SELECT id, username, email, role, unit_id, status, is_dispatcher, created_at, last_login FROM users ORDER BY created_at DESC'
  );
  return result.rows;
}

export async function getUserChannelAccess(userId) {
  const result = await pool.query(
    'SELECT channel_id FROM user_channel_access WHERE user_id = $1',
    [userId]
  );
  return result.rows.map(r => r.channel_id);
}

export async function getUserByUnitId(unitId) {
  const result = await pool.query(
    'SELECT id, username, email, role, unit_id, status, is_dispatcher, created_at, last_login FROM users WHERE unit_id = $1',
    [unitId]
  );
  return result.rows[0];
}

export async function getUsersWithDuplicateUnitId(unitId) {
  if (!unitId) return [];
  const result = await pool.query(
    'SELECT id, username, unit_id FROM users WHERE unit_id = $1',
    [unitId]
  );
  return result.rows;
}

export async function setUserChannelAccess(userId, channelIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_channel_access WHERE user_id = $1', [userId]);
    for (const channelId of channelIds) {
      await client.query(
        'INSERT INTO user_channel_access (user_id, channel_id) VALUES ($1, $2)',
        [userId, channelId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteUser(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_channel_access WHERE user_id = $1', [id]);
    await client.query('DELETE FROM activity_logs WHERE user_id = $1', [id]);
    const result = await client.query(
      'DELETE FROM users WHERE id = $1 RETURNING *',
      [id]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateUser(id, updates) {
  const { role, status, unit_id, email, is_dispatcher } = updates;
  const result = await pool.query(
    `UPDATE users SET role = COALESCE($1, role), status = COALESCE($2, status), 
     unit_id = COALESCE($3, unit_id), email = COALESCE($4, email), 
     is_dispatcher = COALESCE($5, is_dispatcher) WHERE id = $6 RETURNING *`,
    [role, status, unit_id, email, is_dispatcher, id]
  );
  return result.rows[0];
}

export async function updateUserPassword(id, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await pool.query(
    'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *',
    [hash, id]
  );
  return result.rows[0];
}

export async function updateLastLogin(userId) {
  await pool.query(
    'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1',
    [userId]
  );
}

export async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

export async function getAllChannels() {
  const result = await pool.query(
    "SELECT *, COALESCE(zone, 'Default') || '__' || name AS room_key FROM channels ORDER BY zone, name"
  );
  return result.rows;
}

export async function updateChannel(id, updates) {
  const { enabled, zone } = updates;
  const result = await pool.query(
    `UPDATE channels SET enabled = COALESCE($1, enabled), 
     zone = COALESCE($2, zone) WHERE id = $3 RETURNING *, COALESCE(zone, 'Default') || '__' || name AS room_key`,
    [enabled, zone, id]
  );
  return result.rows[0];
}

export async function logActivity(userId, username, action, details, channel = null) {
  await pool.query(
    `INSERT INTO activity_logs (user_id, username, action, details, channel) 
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, username, action, JSON.stringify(details), channel]
  );
}

export async function getActivityLogs(limit = 100) {
  const result = await pool.query(
    `SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getAllZones() {
  const result = await pool.query(
    'SELECT * FROM zones ORDER BY name'
  );
  return result.rows;
}

export async function createZone(name) {
  const result = await pool.query(
    'INSERT INTO zones (name) VALUES ($1) RETURNING *',
    [name]
  );
  return result.rows[0];
}

export async function updateZone(id, name) {
  const result = await pool.query(
    'UPDATE zones SET name = $1 WHERE id = $2 RETURNING *',
    [name, id]
  );
  return result.rows[0];
}

export async function deleteZone(id) {
  const result = await pool.query(
    'DELETE FROM zones WHERE id = $1 RETURNING *',
    [id]
  );
  return result.rows[0];
}

export async function createChannel(name, zoneName, zoneId = null) {
  const resolvedZone = zoneName || 'Default';
  const result = await pool.query(
    "INSERT INTO channels (name, zone, zone_id, enabled) VALUES ($1, $2, $3, true) RETURNING *, $2 || '__' || $1 AS room_key",
    [name, resolvedZone, zoneId]
  );
  return result.rows[0];
}

export async function deleteChannel(id) {
  const result = await pool.query(
    'DELETE FROM channels WHERE id = $1 RETURNING *',
    [id]
  );
  return result.rows[0];
}

export async function upsertUnitPresence(identity, channel, status, location = null, isEmergency = false) {
  const result = await pool.query(
    `INSERT INTO units (unit_identity, channel, status, last_seen, location, is_emergency)
     VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5)
     ON CONFLICT (unit_identity)
     DO UPDATE SET channel = EXCLUDED.channel,
                   status = EXCLUDED.status,
                   last_seen = CURRENT_TIMESTAMP,
                   location = EXCLUDED.location,
                   is_emergency = CASE
                     WHEN EXCLUDED.is_emergency = true THEN true
                     ELSE units.is_emergency
                   END
     RETURNING *`,
    [identity, channel, status, location, isEmergency]
  );
  return result.rows[0];
}

export async function getAllUnitPresence() {
  const result = await pool.query(
    `SELECT *
     FROM units 
     WHERE last_seen > NOW() - INTERVAL '8 hours'
     ORDER BY unit_identity`
  );
  return result.rows;
}

export async function cleanupStaleUnits() {
  // Remove units not seen in 8 hours (aligned with getAllUnitPresence retention window)
  const result = await pool.query(
    `DELETE FROM units WHERE last_seen < NOW() - INTERVAL '8 hours' RETURNING *`
  );
  return result.rows;
}

export async function logRadioEvent(identity, channel, eventType, metadata = {}) {
  await pool.query(
    `INSERT INTO radio_events (unit_identity, channel, event_type, metadata)
     VALUES ($1, $2, $3, $4)`,
    [identity, channel, eventType, metadata]
  );
}

export async function getRadioEvents(limit = 100) {
  const result = await pool.query(
    `SELECT * FROM radio_events ORDER BY timestamp DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

export async function getMonitorSet(dispatcherId) {
  const result = await pool.query(
    `SELECT * FROM dispatch_monitor_sets WHERE dispatcher_id = $1`,
    [dispatcherId]
  );
  return result.rows[0];
}

export async function setMonitorSet(dispatcherId, primary, monitored, primaryTxChannelId = null) {
  const result = await pool.query(
    `INSERT INTO dispatch_monitor_sets (dispatcher_id, primary_tx_channel, monitored_channels, primary_tx_channel_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (dispatcher_id)
     DO UPDATE SET primary_tx_channel = EXCLUDED.primary_tx_channel,
                   monitored_channels = EXCLUDED.monitored_channels,
                   primary_tx_channel_id = EXCLUDED.primary_tx_channel_id
     RETURNING *`,
    [dispatcherId, primary, JSON.stringify(monitored), primaryTxChannelId]
  );
  return result.rows[0];
}

export async function setUnitEmergency(unitId, active) {
  const result = await pool.query(
    `UPDATE units SET is_emergency = $1, last_seen = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
    [active, unitId]
  );
  return result.rows[0];
}

export async function clearUnitEmergencyByIdentity(unitIdentity) {
  const result = await pool.query(
    `UPDATE units SET is_emergency = false, last_seen = CURRENT_TIMESTAMP WHERE unit_identity = $1 RETURNING *`,
    [unitIdentity]
  );
  return result.rows[0];
}

export async function getAllRadioChannels() {
  const result = await pool.query(`SELECT * FROM radio_channels ORDER BY name`);
  return result.rows;
}

export async function createRadioChannel(name, livekitRoomName, isEmergencyOnly = false, isActive = true) {
  const result = await pool.query(
    `INSERT INTO radio_channels (name, livekit_room_name, is_emergency_only, is_active)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, livekitRoomName, isEmergencyOnly, isActive]
  );
  return result.rows[0];
}

export async function updateRadioChannel(id, updates) {
  const { name, livekit_room_name, is_emergency_only, is_active } = updates;
  const result = await pool.query(
    `UPDATE radio_channels SET 
       name = COALESCE($1, name),
       livekit_room_name = COALESCE($2, livekit_room_name),
       is_emergency_only = COALESCE($3, is_emergency_only),
       is_active = COALESCE($4, is_active)
     WHERE id = $5 RETURNING *`,
    [name, livekit_room_name, is_emergency_only, is_active, id]
  );
  return result.rows[0];
}

export async function getAllChannelPatches() {
  const result = await pool.query(`SELECT * FROM channel_patches ORDER BY name`);
  return result.rows;
}

export async function createChannelPatch(name, sourceChannelId, targetChannelId, isEnabled = true) {
  const result = await pool.query(
    `INSERT INTO channel_patches (name, source_channel_id, target_channel_id, is_enabled)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, sourceChannelId, targetChannelId, isEnabled]
  );
  return result.rows[0];
}

export async function updateChannelPatch(id, updates) {
  const { name, source_channel_id, target_channel_id, is_enabled } = updates;
  const result = await pool.query(
    `UPDATE channel_patches SET 
       name = COALESCE($1, name),
       source_channel_id = COALESCE($2, source_channel_id),
       target_channel_id = COALESCE($3, target_channel_id),
       is_enabled = COALESCE($4, is_enabled)
     WHERE id = $5 RETURNING *`,
    [name, source_channel_id, target_channel_id, is_enabled, id]
  );
  return result.rows[0];
}

export async function getAiSetting(key) {
  const result = await pool.query(
    'SELECT value FROM ai_settings WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value;
}

export async function setAiSetting(key, value) {
  const result = await pool.query(
    `INSERT INTO ai_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [key, value]
  );
  return result.rows[0];
}

export async function isAiDispatchEnabled() {
  const value = await getAiSetting('ai_dispatch_enabled');
  return value === 'true';
}

export async function setAiDispatchEnabled(enabled) {
  return setAiSetting('ai_dispatch_enabled', enabled ? 'true' : 'false');
}

export async function getAiDispatchChannel() {
  const value = await getAiSetting('ai_dispatch_channel');
  return value || null;
}

export async function setAiDispatchChannel(channelName) {
  return setAiSetting('ai_dispatch_channel', channelName || '');
}

export async function createChannelMessage(channel, sender, messageType, content = null, audioUrl = null, audioDuration = null, audioData = null) {
  const result = await pool.query(
    `INSERT INTO channel_messages (channel, sender, message_type, content, audio_url, audio_duration, audio_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, channel, sender, message_type, content, audio_url, audio_duration, transcription, created_at`,
    [channel, sender, messageType, content, audioUrl, audioDuration, audioData]
  );
  return result.rows[0];
}

export async function getAudioDataByFilename(filename) {
  const audioUrl = `/api/messages/audio/${filename}`;
  const result = await pool.query(
    `SELECT audio_data FROM channel_messages WHERE audio_url = $1 AND audio_data IS NOT NULL LIMIT 1`,
    [audioUrl]
  );
  return result.rows[0]?.audio_data || null;
}

export async function getAudioMessageDiagnostics(filename) {
  const audioUrl = `/api/messages/audio/${filename}`;
  const [urlMatch, totalAudio] = await Promise.all([
    pool.query(
      `SELECT id, channel, sender, created_at, (audio_data IS NOT NULL) AS has_data FROM channel_messages WHERE audio_url = $1 LIMIT 1`,
      [audioUrl]
    ),
    pool.query(
      `SELECT COUNT(*) AS cnt FROM channel_messages WHERE message_type = 'audio'`
    )
  ]);
  return {
    attemptedUrl: audioUrl,
    urlMatchFound: urlMatch.rows.length > 0,
    urlMatchRow: urlMatch.rows[0] || null,
    totalAudioMessages: parseInt(totalAudio.rows[0]?.cnt || '0', 10)
  };
}

export async function getAudioDataById(messageId) {
  const result = await pool.query(
    `SELECT audio_data FROM channel_messages WHERE id = $1`,
    [messageId]
  );
  return result.rows[0]?.audio_data || null;
}

export async function getChannelMessages(channel, limit = 50, offset = 0) {
  const result = await pool.query(
    `SELECT id, channel, sender, message_type, content, audio_url, audio_duration, transcription, created_at FROM channel_messages WHERE channel = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [channel, limit, offset]
  );
  return result.rows.reverse();
}

export async function updateMessageTranscription(messageId, transcription) {
  const result = await pool.query(
    `UPDATE channel_messages SET transcription = $1 WHERE id = $2 RETURNING *`,
    [transcription, messageId]
  );
  return result.rows[0];
}

export async function getMessageById(messageId) {
  const result = await pool.query(
    `SELECT id, channel, sender, message_type, content, audio_url, audio_duration, transcription, created_at FROM channel_messages WHERE id = $1`,
    [messageId]
  );
  return result.rows[0];
}

export async function getMessagesByDateRange(channel, from, to, type = null) {
  let query = `SELECT id, channel, sender, message_type, content, audio_url, audio_duration, transcription, created_at FROM channel_messages WHERE channel = $1 AND created_at >= $2 AND created_at <= $3`;
  const params = [channel, new Date(from), new Date(to)];
  if (type) {
    query += ` AND message_type = $4`;
    params.push(type);
  }
  query += ` ORDER BY created_at ASC`;
  const result = await pool.query(query, params);
  return result.rows;
}

export async function getAudioLogs({ channels, units, from, to, limit = 100, offset = 0 }) {
  let paramIndex = 1;
  const params = [];
  const conditions = ["message_type = 'audio'"];

  if (channels && channels.length > 0) {
    conditions.push(`channel = ANY($${paramIndex})`);
    params.push(channels);
    paramIndex++;
  }
  if (units && units.length > 0) {
    conditions.push(`sender = ANY($${paramIndex})`);
    params.push(units);
    paramIndex++;
  }
  if (from) {
    conditions.push(`created_at >= $${paramIndex}`);
    params.push(new Date(from));
    paramIndex++;
  }
  if (to) {
    conditions.push(`created_at <= $${paramIndex}`);
    params.push(new Date(to));
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM channel_messages ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count);

  const dataParams = [...params, limit, offset];
  const result = await pool.query(
    `SELECT id, channel, sender, message_type, content, audio_url, audio_duration, transcription, created_at, (audio_data IS NOT NULL) AS audio_available FROM channel_messages ${whereClause} ORDER BY created_at DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
    dataParams
  );

  return { rows: result.rows, total };
}

export async function getDistinctUnits() {
  const result = await pool.query(
    `SELECT DISTINCT sender FROM channel_messages WHERE message_type = 'audio' ORDER BY sender`
  );
  return result.rows.map(r => r.sender);
}

export async function getDistinctChannels() {
  const result = await pool.query(
    `SELECT DISTINCT channel FROM channel_messages WHERE message_type = 'audio' ORDER BY channel`
  );
  return result.rows.map(r => r.channel);
}

export async function deleteChannelMessages(channel, olderThanDays = 30) {
  const result = await pool.query(
    `DELETE FROM channel_messages WHERE channel = $1 AND created_at < NOW() - INTERVAL '1 day' * $2 RETURNING *`,
    [channel, olderThanDays]
  );
  return result.rows;
}

export async function getRadioBySerial(serialNumber) {
  const result = await pool.query(
    'SELECT * FROM radios WHERE serial_number = $1',
    [serialNumber]
  );
  return result.rows[0];
}

export async function getRadioByToken(token) {
  const result = await pool.query(
    'SELECT * FROM radios WHERE token = $1',
    [token]
  );
  return result.rows[0];
}

export async function getRadioById(radioId) {
  const result = await pool.query(
    'SELECT * FROM radios WHERE radio_id = $1',
    [radioId]
  );
  return result.rows[0];
}

export async function createRadio(serialNumber, imei, token) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seqResult = await client.query(`SELECT nextval('radios_radio_id_seq') AS next_id`);
    const nextId = parseInt(seqResult.rows[0].next_id, 10);
    const radioId = String(nextId).padStart(6, '0');
    const result = await client.query(
      `INSERT INTO radios (radio_id, serial_number, imei, token)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [radioId, serialNumber, imei || null, token]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function updateRadioLastSeen(radioId) {
  await pool.query(
    'UPDATE radios SET last_seen = CURRENT_TIMESTAMP WHERE radio_id = $1',
    [radioId]
  );
}

export async function getAllRadios() {
  const result = await pool.query(
    `SELECT r.*, u.unit_id AS assigned_unit_identity
     FROM radios r
     LEFT JOIN users u ON r.assigned_unit_id = u.id
     ORDER BY r.radio_id`
  );
  return result.rows;
}

export async function assignRadioUnit(radioId, unitId) {
  const result = await pool.query(
    `UPDATE radios SET assigned_unit_id = $1 WHERE radio_id = $2 RETURNING *`,
    [unitId, radioId]
  );
  return result.rows[0];
}

export async function setRadioLocked(radioId, isLocked) {
  const result = await pool.query(
    `UPDATE radios SET is_locked = $1 WHERE radio_id = $2 RETURNING *`,
    [isLocked, radioId]
  );
  return result.rows[0];
}

export async function setChannelAnnouncementAudio(channelId, audioBuffer) {
  await pool.query(
    `UPDATE channels SET announcement_audio = $1 WHERE id = $2`,
    [audioBuffer, channelId]
  );
}

export async function getChannelAnnouncementAudio(channelId) {
  const result = await pool.query(
    `SELECT announcement_audio FROM channels WHERE id = $1`,
    [channelId]
  );
  return result.rows[0]?.announcement_audio || null;
}

export async function setZoneAnnouncementAudio(zoneId, audioBuffer) {
  await pool.query(
    `UPDATE zones SET announcement_audio = $1 WHERE id = $2`,
    [audioBuffer, zoneId]
  );
}

export async function getZoneAnnouncementAudio(zoneId) {
  const result = await pool.query(
    `SELECT announcement_audio FROM zones WHERE id = $1`,
    [zoneId]
  );
  return result.rows[0]?.announcement_audio || null;
}

export async function getRadioByAssignedUserId(userId) {
  const result = await pool.query(
    'SELECT * FROM radios WHERE assigned_unit_id = $1 ORDER BY last_seen DESC NULLS LAST LIMIT 1',
    [userId]
  );
  return result.rows[0] || null;
}

export async function recordPageAck(pageId, unitId, radioId) {
  const result = await pool.query(
    `INSERT INTO page_acks (page_id, unit_id, radio_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (page_id, radio_id) DO UPDATE SET acked_at = CURRENT_TIMESTAMP
     RETURNING *`,
    [pageId, unitId || null, radioId || null]
  );
  return result.rows[0];
}

export async function getOrSetRadioDeviceUUID(radioId) {
  const existing = await pool.query(
    'SELECT device_uuid FROM radios WHERE radio_id = $1',
    [radioId]
  );
  if (!existing.rows[0]) return null;
  if (existing.rows[0].device_uuid) return existing.rows[0].device_uuid;
  const newUUID = (await pool.query('SELECT gen_random_uuid() AS uuid')).rows[0].uuid;
  await pool.query('UPDATE radios SET device_uuid = $1 WHERE radio_id = $2', [newUUID, radioId]);
  return newUUID;
}

export async function upsertDevice(deviceId, unitUserId, deviceType, deviceLabel) {
  const result = await pool.query(
    `INSERT INTO devices (id, unit_id, device_type, device_label, last_seen)
     VALUES ($1::uuid, $2, $3, $4, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET
       unit_id = COALESCE(EXCLUDED.unit_id, devices.unit_id),
       device_type = EXCLUDED.device_type,
       device_label = COALESCE(EXCLUDED.device_label, devices.device_label),
       last_seen = CURRENT_TIMESTAMP
     RETURNING *`,
    [deviceId, unitUserId || null, deviceType || 'browser', deviceLabel || null]
  );
  return result.rows[0];
}

export async function getPageAcks(pageId) {
  const result = await pool.query(
    `SELECT pa.*, p.target_type, p.target_id FROM page_acks pa
     JOIN pages p ON pa.page_id = p.id
     WHERE pa.page_id = $1
     ORDER BY pa.acked_at ASC`,
    [pageId]
  );
  return result.rows;
}

export async function getPage(pageId) {
  const result = await pool.query(
    'SELECT * FROM pages WHERE id = $1',
    [pageId]
  );
  return result.rows[0];
}

export async function listPagingTones() {
  const result = await pool.query(
    'SELECT id, name, is_active, created_at FROM paging_tones ORDER BY created_at DESC'
  );
  return result.rows;
}

export async function savePagingTone(name, audioData) {
  const result = await pool.query(
    `INSERT INTO paging_tones (name, audio_data, is_active) VALUES ($1, $2, false) RETURNING id, name, is_active, created_at`,
    [name, audioData]
  );
  return result.rows[0];
}

export async function activatePagingTone(id) {
  await pool.query('UPDATE paging_tones SET is_active = false');
  const result = await pool.query(
    'UPDATE paging_tones SET is_active = true WHERE id = $1 RETURNING id, name, is_active, created_at',
    [id]
  );
  return result.rows[0];
}

export async function deletePagingTone(id) {
  const result = await pool.query(
    'DELETE FROM paging_tones WHERE id = $1 RETURNING *',
    [id]
  );
  return result.rows[0];
}

export async function getActivePagingTone() {
  const result = await pool.query(
    'SELECT * FROM paging_tones WHERE is_active = true LIMIT 1'
  );
  return result.rows[0];
}

export async function getPagingChannelId() {
  const result = await pool.query(
    "SELECT value FROM ai_settings WHERE key = 'paging_channel_id'"
  );
  return result.rows[0]?.value || null;
}

export async function setPagingChannelId(channelId) {
  await pool.query(
    `INSERT INTO ai_settings (key, value, updated_at) VALUES ('paging_channel_id', $1, CURRENT_TIMESTAMP)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
    [channelId ? String(channelId) : '']
  );
}

export async function updateDeviceLastSeen(deviceId) {
  await pool.query(
    `UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE id = $1::uuid`,
    [deviceId]
  );
}

export async function getAllDevices() {
  const result = await pool.query(
    `SELECT d.id, d.device_type, d.device_label, d.last_seen, d.registered_at,
            u.id AS user_id, u.username, u.unit_id AS unit_identity
     FROM devices d
     LEFT JOIN users u ON d.unit_id = u.id
     ORDER BY d.last_seen DESC NULLS LAST`
  );
  return result.rows;
}

export async function getDeviceById(deviceId) {
  const result = await pool.query(
    `SELECT d.*, u.username, u.unit_id AS unit_identity
     FROM devices d
     LEFT JOIN users u ON d.unit_id = u.id
     WHERE d.id = $1::uuid`,
    [deviceId]
  );
  return result.rows[0];
}

export async function updateDeviceLabel(deviceId, label) {
  const result = await pool.query(
    `UPDATE devices SET device_label = $1 WHERE id = $2::uuid RETURNING *`,
    [label, deviceId]
  );
  return result.rows[0];
}

export async function deleteDevice(deviceId) {
  const result = await pool.query(
    `DELETE FROM devices WHERE id = $1::uuid RETURNING *`,
    [deviceId]
  );
  return result.rows[0];
}

export async function updateRadioFcmToken(radioId, fcmToken) {
  const result = await pool.query(
    `UPDATE radios SET fcm_token = $2 WHERE radio_id = $1 RETURNING *`,
    [radioId, fcmToken]
  );
  return result.rows[0];
}

export async function createPage(message, sender, targetType, targetId) {
  const result = await pool.query(
    `INSERT INTO pages (message, sender, target_type, target_id) VALUES ($1, $2, $3, $4) RETURNING *`,
    [message, sender, targetType, targetId]
  );
  return result.rows[0];
}

export async function getAllFcmTokensForUnit(unitId) {
  const result = await pool.query(
    `SELECT r.fcm_token, r.radio_id, u.unit_id AS unit_identity
     FROM radios r
     JOIN users u ON u.id = r.assigned_unit_id
     WHERE r.fcm_token IS NOT NULL AND u.unit_id = $1`,
    [unitId]
  );
  return result.rows;
}

export async function getAllFcmTokens() {
  const result = await pool.query(
    `SELECT r.fcm_token, r.radio_id, u.unit_id AS unit_identity
     FROM radios r
     LEFT JOIN users u ON u.id = r.assigned_unit_id
     WHERE r.fcm_token IS NOT NULL`
  );
  return result.rows;
}

export default pool;
