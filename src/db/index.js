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
        name VARCHAR(50) UNIQUE NOT NULL,
        zone VARCHAR(100) NOT NULL,
        zone_id INTEGER REFERENCES zones(id),
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES zones(id)`);

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

    const defaultZones = [
      'Zone 1 - Operations',
      'Zone 2 - Fire',
      'Zone 3 - Secure Command',
    ];

    for (const zoneName of defaultZones) {
      await client.query(
        `INSERT INTO zones (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [zoneName]
      );
    }

    const defaultChannels = [
      { name: 'OPS1', zone: 'Zone 1 - Operations' },
      { name: 'OPS2', zone: 'Zone 1 - Operations' },
      { name: 'TAC1', zone: 'Zone 1 - Operations' },
      { name: 'FIRE1', zone: 'Zone 2 - Fire' },
      { name: 'FIRE2', zone: 'Zone 2 - Fire' },
      { name: 'FIRE3', zone: 'Zone 2 - Fire' },
      { name: 'FIRE4', zone: 'Zone 2 - Fire' },
      { name: 'FIRE5', zone: 'Zone 2 - Fire' },
      { name: 'FIRE6', zone: 'Zone 2 - Fire' },
      { name: 'FIRE7', zone: 'Zone 2 - Fire' },
      { name: 'FIRE8', zone: 'Zone 2 - Fire' },
      { name: 'SECURE_CMD', zone: 'Zone 3 - Secure Command' },
    ];

    for (const ch of defaultChannels) {
      const zoneResult = await client.query(
        `SELECT id FROM zones WHERE name = $1`,
        [ch.zone]
      );
      const zoneId = zoneResult.rows[0]?.id;
      await client.query(
        `INSERT INTO channels (name, zone, zone_id) VALUES ($1, $2, $3) 
         ON CONFLICT (name) DO UPDATE SET zone_id = EXCLUDED.zone_id`,
        [ch.name, ch.zone, zoneId]
      );
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
    'SELECT * FROM channels ORDER BY zone, name'
  );
  return result.rows;
}

export async function updateChannel(id, updates) {
  const { enabled, zone } = updates;
  const result = await pool.query(
    `UPDATE channels SET enabled = COALESCE($1, enabled), 
     zone = COALESCE($2, zone) WHERE id = $3 RETURNING *`,
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
  const result = await pool.query(
    'INSERT INTO channels (name, zone, zone_id, enabled) VALUES ($1, $2, $3, true) RETURNING *',
    [name, zoneName, zoneId]
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
                   is_emergency = EXCLUDED.is_emergency
     RETURNING *`,
    [identity, channel, status, location, isEmergency]
  );
  return result.rows[0];
}

export async function getAllUnitPresence() {
  const result = await pool.query(`SELECT * FROM units ORDER BY unit_identity`);
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

export default pool;
