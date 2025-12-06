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
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'user',
        unit_id VARCHAR(50),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) UNIQUE NOT NULL,
        zone VARCHAR(100) NOT NULL,
        enabled BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
      await client.query(
        `INSERT INTO channels (name, zone) VALUES ($1, $2) 
         ON CONFLICT (name) DO NOTHING`,
        [ch.name, ch.zone]
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

export async function createUser(username, password, role = "user") {
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING *",
    [username, hash, role]
  );
  return result.rows[0];
}

export async function getAllUsers() {
  const result = await pool.query(
    "SELECT id, username, role, unit_id, status, created_at, last_login FROM users ORDER BY created_at DESC"
  );
  return result.rows;
}

export async function updateUser(id, updates) {
  const { role, status, unit_id } = updates;
  const result = await pool.query(
    `UPDATE users SET role = COALESCE($1, role), status = COALESCE($2, status), 
     unit_id = COALESCE($3, unit_id) WHERE id = $4 RETURNING *`,
    [role, status, unit_id, id]
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

export default pool;
