import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
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

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_dispatcher BOOLEAN DEFAULT false
    `);

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

    await client.query(`
      ALTER TABLE channels ADD COLUMN IF NOT EXISTS zone_id INTEGER REFERENCES zones(id)
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
    
    await client.query(`
      CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)
    `);

    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
    
    const existingAdmin = await client.query(
      "SELECT id FROM users WHERE username = $1",
      [adminUsername]
    );
    
    if (existingAdmin.rows.length === 0) {
      const hash = await bcrypt.hash(adminPassword, 10);
      await client.query(
        "INSERT INTO users (username, password_hash, role, status) VALUES ($1, $2, $3, $4)",
        [adminUsername, hash, "admin", "active"]
      );
      console.log(`Default admin account created: ${adminUsername}`);
    }

    const defaultZones = [
      "Zone 1 - Operations",
      "Zone 2 - Fire",
      "Zone 3 - Secure Command",
    ];

    for (const zoneName of defaultZones) {
      await client.query(
        `INSERT INTO zones (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
        [zoneName]
      );
    }

    const defaultChannels = [
      { name: "OPS1", zone: "Zone 1 - Operations" },
      { name: "OPS2", zone: "Zone 1 - Operations" },
      { name: "TAC1", zone: "Zone 1 - Operations" },
      { name: "FIRE1", zone: "Zone 2 - Fire" },
      { name: "FIRE2", zone: "Zone 2 - Fire" },
      { name: "FIRE3", zone: "Zone 2 - Fire" },
      { name: "FIRE4", zone: "Zone 2 - Fire" },
      { name: "FIRE5", zone: "Zone 2 - Fire" },
      { name: "FIRE6", zone: "Zone 2 - Fire" },
      { name: "FIRE7", zone: "Zone 2 - Fire" },
      { name: "FIRE8", zone: "Zone 2 - Fire" },
      { name: "SECURE_CMD", zone: "Zone 3 - Secure Command" },
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

    console.log("Database initialized successfully");
  } finally {
    client.release();
  }
}

export async function getUser(username) {
  const result = await pool.query(
    "SELECT * FROM users WHERE username = $1",
    [username]
  );
  return result.rows[0];
}

export async function createUser(username, password, role = "user", email = null, unit_id = null) {
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    "INSERT INTO users (username, password_hash, role, email, unit_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [username, hash, role, email, unit_id]
  );
  return result.rows[0];
}

export async function createUserWithChannels(username, password, role = "user", email = null, unit_id = null, channelIds = [], is_dispatcher = false) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    const hash = await bcrypt.hash(password, 10);
    const userResult = await client.query(
      "INSERT INTO users (username, password_hash, role, email, unit_id, is_dispatcher) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [username, hash, role, email, unit_id, is_dispatcher]
    );
    const user = userResult.rows[0];

    for (const channelId of channelIds) {
      await client.query(
        "INSERT INTO user_channel_access (user_id, channel_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [user.id, channelId]
      );
    }

    await client.query("COMMIT");
    return user;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getAllUsers() {
  const result = await pool.query(
    "SELECT id, username, email, role, unit_id, status, is_dispatcher, created_at, last_login FROM users ORDER BY created_at DESC"
  );
  return result.rows;
}

export async function getUserChannelAccess(userId) {
  const result = await pool.query(
    "SELECT channel_id FROM user_channel_access WHERE user_id = $1",
    [userId]
  );
  return result.rows.map(r => r.channel_id);
}

export async function setUserChannelAccess(userId, channelIds) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM user_channel_access WHERE user_id = $1", [userId]);
    for (const channelId of channelIds) {
      await client.query(
        "INSERT INTO user_channel_access (user_id, channel_id) VALUES ($1, $2)",
        [userId, channelId]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteUser(id) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    await client.query("DELETE FROM user_channel_access WHERE user_id = $1", [id]);
    await client.query("DELETE FROM activity_logs WHERE user_id = $1", [id]);
    
    const result = await client.query(
      "DELETE FROM users WHERE id = $1 RETURNING *",
      [id]
    );
    
    await client.query("COMMIT");
    return result.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
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
    "UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *",
    [hash, id]
  );
  return result.rows[0];
}

export async function updateLastLogin(userId) {
  await pool.query(
    "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1",
    [userId]
  );
}

export async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password_hash);
}

export async function getAllChannels() {
  const result = await pool.query(
    "SELECT * FROM channels ORDER BY zone, name"
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
    "SELECT * FROM zones ORDER BY name"
  );
  return result.rows;
}

export async function createZone(name) {
  const result = await pool.query(
    "INSERT INTO zones (name) VALUES ($1) RETURNING *",
    [name]
  );
  return result.rows[0];
}

export async function updateZone(id, name) {
  const result = await pool.query(
    "UPDATE zones SET name = $1 WHERE id = $2 RETURNING *",
    [name, id]
  );
  return result.rows[0];
}

export async function deleteZone(id) {
  const result = await pool.query(
    "DELETE FROM zones WHERE id = $1 RETURNING *",
    [id]
  );
  return result.rows[0];
}

export async function createChannel(name, zoneName, zoneId = null) {
  const result = await pool.query(
    "INSERT INTO channels (name, zone, zone_id, enabled) VALUES ($1, $2, $3, true) RETURNING *",
    [name, zoneName, zoneId]
  );
  return result.rows[0];
}

export async function deleteChannel(id) {
  const result = await pool.query(
    "DELETE FROM channels WHERE id = $1 RETURNING *",
    [id]
  );
  return result.rows[0];
}

export default pool;
