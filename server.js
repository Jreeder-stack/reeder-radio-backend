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
  createUserWithChannels,
  getAllUsers,
  updateUser,
  updateUserPassword,
  deleteUser,
  getUserChannelAccess,
  setUserChannelAccess,
  updateLastLogin,
  verifyPassword,
  getAllChannels,
  updateChannel,
  createChannel,
  deleteChannel,
  getAllZones,
  createZone,
  updateZone,
  deleteZone,
  logActivity,
  getActivityLogs,
} from "./db.js";
import dispatchRouter from "./dispatch/dispatchRouter.js";
import { getDispatcher } from "./src/services/aiDispatchService.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Trust proxy for Render and other reverse proxy environments
// This is required for secure cookies to work behind a proxy
app.set("trust proxy", 1);

// CORS configuration - restrict to trusted origins in production
const corsOptions = {
  origin: process.env.NODE_ENV === 'production' 
    ? (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : false)
    : true, // Allow all origins in development
  credentials: true,
};
app.use(cors(corsOptions));
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
      sameSite: isProduction ? "none" : "lax", // None in production for cross-origin requests
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;

// Simple in-memory rate limiter for auth endpoints
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_AUTH_ATTEMPTS = 10; // Max attempts per window

function rateLimitAuth(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitStore.has(ip)) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  const entry = rateLimitStore.get(ip);
  
  // Reset if window expired
  if (now > entry.resetAt) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return next();
  }
  
  // Check if over limit
  if (entry.count >= MAX_AUTH_ATTEMPTS) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({ 
      error: "Too many attempts. Please try again later.",
      retryAfter 
    });
  }
  
  entry.count++;
  next();
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(ip);
    }
  }
}, 60 * 1000); // Clean every minute

console.log("=== STARTUP CONFIG DEBUG ===");
console.log("NODE_ENV:", process.env.NODE_ENV || "not set");
console.log("LIVEKIT_API_KEY exists:", !!LIVEKIT_API_KEY);
console.log("LIVEKIT_API_KEY length:", LIVEKIT_API_KEY ? LIVEKIT_API_KEY.length : 0);
console.log("LIVEKIT_API_KEY first 8 chars:", LIVEKIT_API_KEY ? LIVEKIT_API_KEY.substring(0, 8) + "..." : "N/A");
console.log("LIVEKIT_API_SECRET exists:", !!LIVEKIT_API_SECRET);
console.log("LIVEKIT_API_SECRET length:", LIVEKIT_API_SECRET ? LIVEKIT_API_SECRET.length : 0);
console.log("LIVEKIT_URL:", process.env.LIVEKIT_URL || "NOT SET");
console.log("VITE_LIVEKIT_URL:", process.env.VITE_LIVEKIT_URL || "NOT SET");
console.log("SESSION_SECRET exists:", !!process.env.SESSION_SECRET);
console.log("=== END STARTUP CONFIG ===");

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

app.post("/api/auth/login", rateLimitAuth, async (req, res) => {
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
      is_dispatcher: user.is_dispatcher || false,
    };

    res.json({
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        unit_id: user.unit_id,
        is_dispatcher: user.is_dispatcher || false,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/api/auth/register", rateLimitAuth, async (req, res) => {
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
    
    console.log('[API /channels] User:', req.session.user.username, 'Role:', req.session.user.role);
    console.log('[API /channels] Total channels:', channels.length, 'Enabled:', enabledChannels.length);
    
    // Admins see all enabled channels
    if (req.session.user.role === "admin") {
      console.log('[API /channels] Admin - returning all enabled channels');
      return res.json({ channels: enabledChannels });
    }
    
    // Regular users see only their assigned channels
    const userChannelIds = await getUserChannelAccess(req.session.user.id);
    console.log('[API /channels] User channel IDs:', userChannelIds);
    
    // If user has no assigned channels, give them access to all enabled channels (fallback)
    if (userChannelIds.length === 0) {
      console.log('[API /channels] No assignments, falling back to all enabled');
      return res.json({ channels: enabledChannels });
    }
    
    // Filter to only channels the user has access to
    const accessibleChannels = enabledChannels.filter(c => userChannelIds.includes(c.id));
    console.log('[API /channels] Accessible channels:', accessibleChannels.length);
    res.json({ channels: accessibleChannels });
  } catch (error) {
    console.error("Get channels error:", error);
    res.status(500).json({ error: "Failed to get channels" });
  }
});

app.post("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const { username, password, email, unit_id, role, channelIds, is_dispatcher } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }

    const existing = await getUser(username);
    if (existing) {
      return res.status(400).json({ error: "Username already taken" });
    }

    const user = await createUserWithChannels(
      username,
      password,
      role || "user",
      email || null,
      unit_id || null,
      channelIds || [],
      is_dispatcher || false
    );

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "create_user",
      { newUser: username, role: role || "user", is_dispatcher: is_dispatcher || false }
    );

    res.json({ user });
  } catch (error) {
    console.error("Create user error:", error);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (parseInt(id) === req.session.user.id) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    const user = await deleteUser(id);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "delete_user",
      { deletedUser: user.username }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Delete user error:", error);
    res.status(500).json({ error: "Failed to delete user" });
  }
});

app.get("/api/admin/users/:id/channels", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const channelIds = await getUserChannelAccess(id);
    res.json({ channelIds });
  } catch (error) {
    console.error("Get user channels error:", error);
    res.status(500).json({ error: "Failed to get user channels" });
  }
});

app.put("/api/admin/users/:id/channels", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { channelIds } = req.body;
    
    await setUserChannelAccess(id, channelIds || []);

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "update_user_channels",
      { userId: id, channelIds }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Update user channels error:", error);
    res.status(500).json({ error: "Failed to update user channels" });
  }
});

app.put("/api/admin/users/:id/password", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { password } = req.body;
    
    if (!password || password.length < 4) {
      return res.status(400).json({ error: "Password must be at least 4 characters" });
    }

    await updateUserPassword(id, password);

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "reset_password",
      { userId: id }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Reset password error:", error);
    res.status(500).json({ error: "Failed to reset password" });
  }
});

app.get("/api/admin/zones", requireAdmin, async (req, res) => {
  try {
    const zones = await getAllZones();
    res.json({ zones });
  } catch (error) {
    console.error("Get zones error:", error);
    res.status(500).json({ error: "Failed to get zones" });
  }
});

app.post("/api/admin/zones", requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: "Zone name required" });
    }

    const zone = await createZone(name);

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "create_zone",
      { zoneName: name }
    );

    res.json({ zone });
  } catch (error) {
    console.error("Create zone error:", error);
    res.status(500).json({ error: "Failed to create zone" });
  }
});

app.put("/api/admin/zones/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name } = req.body;
    
    const zone = await updateZone(id, name);
    if (!zone) {
      return res.status(404).json({ error: "Zone not found" });
    }

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "update_zone",
      { zoneId: id, name }
    );

    res.json({ zone });
  } catch (error) {
    console.error("Update zone error:", error);
    res.status(500).json({ error: "Failed to update zone" });
  }
});

app.delete("/api/admin/zones/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const zone = await deleteZone(id);
    if (!zone) {
      return res.status(404).json({ error: "Zone not found" });
    }

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "delete_zone",
      { zoneName: zone.name }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Delete zone error:", error);
    res.status(500).json({ error: "Failed to delete zone" });
  }
});

app.post("/api/admin/channels", requireAdmin, async (req, res) => {
  try {
    const { name, zone, zoneId } = req.body;
    
    if (!name || !zone) {
      return res.status(400).json({ error: "Channel name and zone required" });
    }

    const channel = await createChannel(name, zone, zoneId);

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "create_channel",
      { channelName: name, zone }
    );

    res.json({ channel });
  } catch (error) {
    console.error("Create channel error:", error);
    res.status(500).json({ error: "Failed to create channel" });
  }
});

app.delete("/api/admin/channels/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const channel = await deleteChannel(id);
    if (!channel) {
      return res.status(404).json({ error: "Channel not found" });
    }

    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "delete_channel",
      { channelName: channel.name }
    );

    res.json({ success: true });
  } catch (error) {
    console.error("Delete channel error:", error);
    res.status(500).json({ error: "Failed to delete channel" });
  }
});

app.use("/api/dispatch", requireAuth, dispatchRouter);

app.use(express.static(path.join(__dirname, "client", "dist")));

app.get("/getToken", requireAuth, async (req, res) => {
  const { identity, room } = req.query;
  
  console.log("=== /getToken DEBUG START ===");
  console.log("Request query params:", { identity, room });
  console.log("Session user:", req.session.user ? { id: req.session.user.id, username: req.session.user.username, role: req.session.user.role } : "NO SESSION USER");
  console.log("LIVEKIT_API_KEY exists:", !!LIVEKIT_API_KEY);
  console.log("LIVEKIT_API_KEY length:", LIVEKIT_API_KEY ? LIVEKIT_API_KEY.length : 0);
  console.log("LIVEKIT_API_KEY first 8 chars:", LIVEKIT_API_KEY ? LIVEKIT_API_KEY.substring(0, 8) + "..." : "N/A");
  console.log("LIVEKIT_API_SECRET exists:", !!LIVEKIT_API_SECRET);
  console.log("LIVEKIT_API_SECRET length:", LIVEKIT_API_SECRET ? LIVEKIT_API_SECRET.length : 0);
  console.log("LIVEKIT_URL:", process.env.LIVEKIT_URL || "NOT SET");

  if (!identity || !room) {
    console.log("ERROR: Missing identity or room");
    return res.status(400).json({ error: "identity and room are required" });
  }

  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    console.log("ERROR: LiveKit credentials not configured");
    return res.status(500).json({ error: "LiveKit credentials not configured" });
  }

  try {
    // Verify user has access to the requested channel
    const channels = await getAllChannels();
    console.log("Total channels from DB:", channels.length);
    const requestedChannel = channels.find(c => c.name === room && c.enabled);
    console.log("Requested channel found:", requestedChannel ? { id: requestedChannel.id, name: requestedChannel.name } : "NOT FOUND");
    
    if (!requestedChannel) {
      console.log("ERROR: Channel not found or disabled");
      return res.status(404).json({ error: "Channel not found or disabled" });
    }
    
    // Only enforce permissions for non-admin users
    if (req.session.user.role !== "admin") {
      const userChannelIds = await getUserChannelAccess(req.session.user.id);
      console.log("User channel access IDs:", userChannelIds);
      // If user has specific channel assignments, verify access
      if (userChannelIds.length > 0 && !userChannelIds.includes(requestedChannel.id)) {
        console.log("ERROR: Access denied - user doesn't have channel permission");
        return res.status(403).json({ error: "Access denied to this channel" });
      }
    } else {
      console.log("User is admin - bypassing channel permission check");
    }
    
    console.log("Creating AccessToken with identity:", identity, "room:", room);
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

    console.log("Generating JWT token...");
    const token = await at.toJwt();
    console.log("Token generated successfully, length:", token.length);
    console.log("Token first 50 chars:", token.substring(0, 50) + "...");
    
    await logActivity(
      req.session.user.id,
      req.session.user.username,
      "join_channel",
      { identity, room },
      room
    );

    // Trigger AI Dispatcher to rejoin if it had disconnected due to no humans
    try {
      const dispatcher = getDispatcher();
      if (dispatcher.configuredChannel === room) {
        dispatcher.rejoinIfNeeded().catch(err => {
          console.log('[AI-Dispatcher] Rejoin error (non-fatal):', err.message);
        });
      }
    } catch (err) {
      // Non-fatal - AI dispatcher features are optional
      console.log('[AI-Dispatcher] Could not trigger rejoin:', err.message);
    }

    console.log("=== /getToken DEBUG END - SUCCESS ===");
    res.json({ token, url: process.env.LIVEKIT_URL });
  } catch (error) {
    console.error("=== /getToken DEBUG END - ERROR ===");
    console.error("Token generation error:", error);
    console.error("Error name:", error.name);
    console.error("Error message:", error.message);
    console.error("Error stack:", error.stack);
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
