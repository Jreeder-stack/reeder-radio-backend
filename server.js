import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import crypto from "crypto";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { fileURLToPath } from "url";
import { AccessToken } from "livekit-server-sdk";
import pool, {
  initializeDatabase,
  getUser,
  createUser,
  getAllUsers,
  updateUser,
  updateLastLogin,
  verifyPassword,
  getAllChannels,
  updateChannel,
  logActivity,
  getActivityLogs,
} from "./db.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const PgSession = connectPgSimple(session);

const isProduction = process.env.NODE_ENV === "production";
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET && isProduction) {
  console.error("FATAL: SESSION_SECRET environment variable is required in production");
  process.exit(1);
}

const sessionSecret = SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.use(
  session({
    store: new PgSession({
      pool: pool,
      tableName: "session",
    }),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const user = await getUser(username);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    if (user.status === "blocked") {
      return res.status(403).json({ error: "Account is blocked" });
    }

    const valid = await verifyPassword(user, password);
    if (!valid) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    await updateLastLogin(user.id);
    await logActivity(user.id, user.username, "login", { ip: req.ip });

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      unit_id: user.unit_id,
    };

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        unit_id: user.unit_id,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    if (password.length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters" });
    }

    const existing = await getUser(username);
    if (existing) {
      return res.status(400).json({ error: "Username already taken" });
    }

    const user = await createUser(username, password);
    await logActivity(user.id, user.username, "register", {});

    req.session.user = {
      id: user.id,
      username: user.username,
      role: user.role,
      unit_id: user.unit_id,
    };

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        unit_id: user.unit_id,
      },
    });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed" });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.json({ success: true });
  });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  res.json({ user: req.session.user });
});

app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (error) {
    console.error("Get users error:", error);
    res.status(500).json({ error: "Failed to get users" });
  }
});

app.put("/api/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const user = await updateUser(id, updates);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "update_user",
      { targetUser: id, updates }
    );

    res.json({ user });
  } catch (error) {
    console.error("Update user error:", error);
    res.status(500).json({ error: "Failed to update user" });
  }
});

app.get("/api/admin/channels", requireAdmin, async (req, res) => {
  try {
    const channels = await getAllChannels();
    res.json({ channels });
  } catch (error) {
    console.error("Get channels error:", error);
    res.status(500).json({ error: "Failed to get channels" });
  }
});

app.put("/api/admin/channels/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const channel = await updateChannel(id, updates);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "update_channel",
      { channelId: id, updates }
    );

    res.json({ channel });
  } catch (error) {
    console.error("Update channel error:", error);
    res.status(500).json({ error: "Failed to update channel" });
  }
});

app.get("/api/admin/logs", requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await getActivityLogs(limit);
    res.json({ logs });
  } catch (error) {
    console.error("Get logs error:", error);
    res.status(500).json({ error: "Failed to get logs" });
  }
});

app.post("/api/activity/log", requireAuth, async (req, res) => {
  try {
    const { action, details, channel } = req.body;
    await logActivity(
      req.session.user.id,
      req.session.user.username,
      action,
      details,
      channel
    );
    res.json({ success: true });
  } catch (error) {
    console.error("Log activity error:", error);
    res.status(500).json({ error: "Failed to log activity" });
  }
});

app.get("/api/channels", requireAuth, async (req, res) => {
  try {
    const channels = await getAllChannels();
    const enabledChannels = channels.filter((c) => c.enabled);
    res.json({ channels: enabledChannels });
  } catch (error) {
    console.error("Get channels error:", error);
    res.status(500).json({ error: "Failed to get channels" });
  }
});

app.use(express.static(path.join(__dirname, "client", "dist")));

app.get("/getToken", requireAuth, async (req, res) => {
  const { identity, room } = req.query;

  if (!identity || !room) {
    return res.status(400).json({ error: "identity and room are required" });
  }

  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: "LiveKit credentials not configured" });
  }

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: identity,
      ttl: "1h",
    });

    at.addGrant({
      roomJoin: true,
      room: room,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();
    
    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "join_channel",
      { identity, room },
      room
    );

    res.json({ token });
  } catch (error) {
    console.error("Token generation error:", error);
    res.status(500).json({ error: "Failed to generate token" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "dist", "index.html"));
});

const PORT = process.env.PORT || 3001;

initializeDatabase()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
