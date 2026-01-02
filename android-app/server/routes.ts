import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";

const BACKEND_URL = process.env.BACKEND_URL || "https://comms.reeder-systems.com";
const CAD_URL = process.env.CAD_URL || "https://cad.reeder-systems.com";
const CAD_WS_URL = process.env.CAD_WS_URL || "wss://cad.reeder-systems.com/ws";
const RADIO_API_KEY = process.env.RADIO_API_KEY;

// Detailed logging helper
function log(category: string, message: string, data?: any) {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [${category}] ${message}`, JSON.stringify(data, null, 2));
  } else {
    console.log(`[${timestamp}] [${category}] ${message}`);
  }
}

function requireCadApiKey(req: Request, res: Response, next: NextFunction) {
  if (!RADIO_API_KEY) {
    return res.status(503).json({ error: "CAD integration not configured - missing API key" });
  }
  next();
}

// Session data stored server-side (in production, use Redis or similar)
interface SessionData {
  cookies: string;
  userId: string;
  unitId: string;
  username: string;
}
const sessions: Map<string, SessionData> = new Map();

// Dev bypass session (always available)
const DEV_SESSION_ID = "dev-bypass-session";
sessions.set(DEV_SESSION_ID, {
  cookies: "",
  userId: "dev-user",
  unitId: "DEV-UNIT",
  username: "Developer",
});

// Middleware to check auth
function requireAuth(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.headers["x-session-id"] as string;
  const session = sessionId ? sessions.get(sessionId) : null;
  
  log("AUTH", `Session check for ${req.method} ${req.path}`, { 
    sessionId: sessionId ? `${sessionId.substring(0, 8)}...` : 'none',
    hasSession: !!session,
    unitId: session?.unitId || 'none'
  });
  
  if (!session) {
    log("AUTH", "Unauthorized - no valid session");
    return res.status(401).json({ error: "Unauthorized" });
  }
  
  (req as any).session = session;
  next();
}

// Forward request to backend with cookies
async function forwardRequest(
  endpoint: string,
  method: string,
  cookies: string,
  body?: any
) {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "Cookie": cookies,
  };

  const options: RequestInit = {
    method,
    headers,
    credentials: "include",
  };

  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(`${BACKEND_URL}${endpoint}`, options);
    
    // Handle 204 No Content and empty responses
    const contentLength = response.headers.get("content-length");
    const hasBody = contentLength !== "0" && response.status !== 204;
    
    let data = null;
    if (hasBody) {
      const text = await response.text();
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { message: text };
        }
      }
    }
    
    return { status: response.status, data };
  } catch (error) {
    console.error(`Backend request failed: ${endpoint}`, error);
    return { status: 500, data: { error: "Backend unavailable" } };
  }
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  // ========== AUTH ==========
  
  // Login - creates session and stores backend cookies + user data server-side
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const { username, password } = req.body;
    
    log("LOGIN", `Login attempt for user: ${username}`);
    
    if (!username || !password) {
      log("LOGIN", "Missing username or password");
      return res.status(400).json({ error: "Username and password required" });
    }

    try {
      log("LOGIN", `Forwarding login request to backend: ${BACKEND_URL}/api/auth/login`);
      const response = await fetch(`${BACKEND_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        credentials: "include",
      });

      // Capture Set-Cookie headers from the backend
      const setCookieHeaders = response.headers.getSetCookie?.() || [];
      const cookieString = setCookieHeaders.map(c => c.split(';')[0]).join('; ');

      const data = await response.json();
      log("LOGIN", `Backend response status: ${response.status}`, { data });

      if (!response.ok) {
        log("LOGIN", `Login failed: ${response.status}`);
        return res.status(response.status).json(data);
      }

      // Extract user info from response
      const user = data.user || {};
      const userId = user.id?.toString() || user.userId?.toString() || username;
      const unitId = user.unitId?.toString() || user.unit_id?.toString() || userId;

      log("LOGIN", `User info extracted`, { userId, unitId, username: user.username });

      // Generate session ID and store session data server-side
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        cookies: cookieString,
        userId,
        unitId,
        username: user.username || username,
      });

      log("LOGIN", `Session created: ${sessionId.substring(0, 8)}... for unit: ${unitId}`);
      log("LOGIN", `Active sessions count: ${sessions.size}`);

      // Return session ID and user info to the client
      res.json({
        success: true,
        sessionId,
        user: {
          id: userId,
          username: user.username || username,
          unitId,
        },
      });
    } catch (error) {
      log("LOGIN", `Login error: ${error}`);
      console.error("Login error:", error);
      res.status(500).json({ error: "Authentication service unavailable" });
    }
  });

  // Logout
  app.post("/api/auth/logout", async (req: Request, res: Response) => {
    const sessionId = req.headers["x-session-id"] as string;
    const session = sessionId ? sessions.get(sessionId) : null;
    
    if (session) {
      await forwardRequest("/api/auth/logout", "POST", session.cookies);
      sessions.delete(sessionId);
    }
    res.json({ success: true });
  });

  // Verify session / get current user
  app.get("/api/auth/verify", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/auth/me", "GET", session.cookies);
    if (result.status === 200) {
      res.json({ 
        valid: true,
        user: result.data
      });
    } else {
      res.status(result.status).json(result.data);
    }
  });

  // ========== CHANNELS ==========
  
  app.get("/api/channels", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/channels", "GET", session.cookies);
    res.status(result.status).json(result.data);
  });

  // ========== PRESENCE / DISPATCH UNITS ==========
  
  app.get("/api/presence", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/dispatch/units", "GET", session.cookies);
    res.status(result.status).json(result.data);
  });
  
  // Update unit info
  app.post("/api/dispatch/unit/update", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/dispatch/unit/update", "POST", session.cookies, {
      ...req.body,
      unit_identity: req.body.unit_identity || session.unitId,
    });
    res.status(result.status).json(result.data);
  });

  // Notify join - triggers AI dispatcher when user joins a channel
  app.post("/api/dispatch/notify-join", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/dispatch/notify-join", "POST", session.cookies, {
      channel: req.body.channel,
      identity: req.body.identity || session.unitId,
    });
    res.status(result.status).json(result.data);
  });
  
  // Get dispatch channels
  app.get("/api/dispatch/channels", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/dispatch/channels", "GET", session.cookies);
    res.status(result.status).json(result.data);
  });
  
  // Get radio events
  app.get("/api/dispatch/events", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/dispatch/events", "GET", session.cookies);
    res.status(result.status).json(result.data);
  });

  // ========== EMERGENCY ==========
  
  // Notify AI dispatcher of emergency state change
  app.post("/api/dispatch/notify-emergency", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/dispatch/notify-emergency", "POST", session.cookies, {
      channel: req.body.channel,
      identity: req.body.identity || session.unitId,
      active: req.body.active
    });
    res.status(result.status).json(result.data);
  });

  app.post("/api/emergency", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const unitId = req.body.unitId || session.unitId;
    const result = await forwardRequest(
      `/api/dispatch/units/${unitId}/emergency`,
      "POST",
      session.cookies,
      { ...req.body, unitId }
    );
    res.status(result.status).json(result.data);
  });

  app.post("/api/emergency/ack", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest(
      "/api/dispatch/emergency/ack",
      "POST",
      session.cookies,
      req.body
    );
    res.status(result.status).json(result.data);
  });

  app.delete("/api/emergency/:unitId", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const unitId = req.params.unitId || session.unitId;
    const result = await forwardRequest(
      `/api/dispatch/units/${unitId}/emergency`,
      "DELETE",
      session.cookies
    );
    res.status(result.status).json(result.data);
  });

  // ========== LIVEKIT ==========
  
  app.get("/api/livekit/token", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const room = req.query.room as string;
    const identity = (req.query.identity as string) || session.unitId;
    
    log("LIVEKIT", `Token request`, { room, identity, sessionUnitId: session.unitId });
    
    const result = await forwardRequest(
      `/getToken?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}`,
      "GET",
      session.cookies
    );
    
    log("LIVEKIT", `Token response`, { 
      status: result.status, 
      hasToken: !!(result.data as any)?.token,
      url: (result.data as any)?.url 
    });
    
    res.status(result.status).json(result.data);
  });

  // ========== LOCATION ==========
  
  app.post("/api/location", requireAuth, async (req: Request, res: Response) => {
    const session = (req as any).session as SessionData;
    const result = await forwardRequest("/api/location", "POST", session.cookies, {
      ...req.body,
      unitId: req.body.unitId || session.unitId,
    });
    res.status(result.status).json(result.data);
  });

  // ========== CONTACTS ==========
  
  app.get("/api/radio/contacts", requireAuth, async (req: Request, res: Response) => {
    if (!RADIO_API_KEY) {
      return res.status(503).json({ error: "Contacts not configured - missing API key" });
    }
    try {
      console.log("[Contacts] Fetching contacts with API key from CAD");
      const response = await fetch(`${CAD_URL}/api/radio/contacts`, {
        method: "GET",
        headers: {
          "X-API-Key": RADIO_API_KEY,
        },
      });
      const data = await response.json();
      console.log("[Contacts] Response status:", response.status, "data:", JSON.stringify(data).slice(0, 500));
      res.status(response.status).json(data);
    } catch (error) {
      console.error("[Contacts] Error:", error);
      res.status(500).json({ error: "Contacts service unavailable" });
    }
  });

  // ========== CAD QUERIES (CommandLink) ==========
  
  // Person query
  app.post("/api/cad/query/person", requireAuth, requireCadApiKey, async (req: Request, res: Response) => {
    try {
      const response = await fetch(`${CAD_URL}/api/radio/query/person`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": RADIO_API_KEY!,
        },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      console.error("CAD person query error:", error);
      res.status(500).json({ error: "CAD service unavailable" });
    }
  });
  
  // Vehicle query
  app.post("/api/cad/query/vehicle", requireAuth, requireCadApiKey, async (req: Request, res: Response) => {
    try {
      const response = await fetch(`${CAD_URL}/api/radio/query/vehicle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": RADIO_API_KEY!,
        },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      console.error("CAD vehicle query error:", error);
      res.status(500).json({ error: "CAD service unavailable" });
    }
  });
  
  // Active calls
  app.get("/api/cad/calls", requireAuth, requireCadApiKey, async (req: Request, res: Response) => {
    try {
      const response = await fetch(`${CAD_URL}/api/radio/calls`, {
        method: "GET",
        headers: {
          "X-API-Key": RADIO_API_KEY!,
        },
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      console.error("CAD active calls error:", error);
      res.status(500).json({ error: "CAD service unavailable" });
    }
  });
  
  // Unit status update (legacy)
  app.post("/api/cad/status", requireAuth, requireCadApiKey, async (req: Request, res: Response) => {
    try {
      const response = await fetch(`${CAD_URL}/api/radio/status`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": RADIO_API_KEY!,
        },
        body: JSON.stringify(req.body),
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      console.error("CAD status update error:", error);
      res.status(500).json({ error: "CAD service unavailable" });
    }
  });

  // Unit status cycle - cycles to next status in CAD workflow
  app.post("/api/cad/unit/:unitId/status/cycle", requireAuth, requireCadApiKey, async (req: Request, res: Response) => {
    const { unitId } = req.params;
    const cycleUrl = `${CAD_URL}/api/radio/unit/${encodeURIComponent(unitId)}/status/cycle`;
    console.log(`[CAD-Cycle] Calling: ${cycleUrl}`);
    try {
      const response = await fetch(cycleUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": RADIO_API_KEY!,
        },
      });
      const text = await response.text();
      console.log(`[CAD-Cycle] Response status: ${response.status}, body: ${text}`);
      
      let data;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { message: text };
      }
      res.status(response.status).json(data);
    } catch (error) {
      console.error("[CAD-Cycle] Error:", error);
      res.status(500).json({ error: "CAD service unavailable" });
    }
  });

  // Get all units status (for initial status fetch)
  app.get("/api/cad/status-check", requireAuth, requireCadApiKey, async (req: Request, res: Response) => {
    try {
      const response = await fetch(`${CAD_URL}/api/radio/status-check`, {
        method: "GET",
        headers: {
          "X-API-Key": RADIO_API_KEY!,
        },
      });
      const data = await response.json();
      res.status(response.status).json(data);
    } catch (error) {
      console.error("CAD status check error:", error);
      res.status(500).json({ error: "CAD service unavailable" });
    }
  });

  // ========== CAD WEBSOCKET PROXY ==========
  
  const wss = new WebSocketServer({ server: httpServer, path: "/ws/cad" });
  
  wss.on("connection", (clientWs) => {
    console.log("[CAD-WS] Client connected to proxy");
    
    if (!RADIO_API_KEY) {
      console.error("[CAD-WS] No API key configured");
      clientWs.close(1008, "API key not configured");
      return;
    }
    
    // Connect to CAD WebSocket with API key
    const cadWs = new WebSocket(CAD_WS_URL, {
      headers: {
        "X-API-Key": RADIO_API_KEY,
      },
    });
    
    cadWs.on("open", () => {
      console.log("[CAD-WS] Connected to CAD WebSocket");
    });
    
    cadWs.on("message", (data) => {
      // Forward messages from CAD to client
      if (clientWs.readyState === WebSocket.OPEN) {
        const message = data.toString();
        
        // Handle ping/pong keepalive
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === "ping") {
            // Respond with pong to keep connection alive
            cadWs.send(JSON.stringify({ type: "pong" }));
            return;
          }
          console.log("[CAD-WS] Forwarding:", parsed.type);
        } catch {}
        
        clientWs.send(message);
      }
    });
    
    cadWs.on("close", (code, reason) => {
      console.log("[CAD-WS] CAD connection closed:", code, reason.toString());
      if (clientWs.readyState === WebSocket.OPEN) {
        // Use valid close codes only (1000-1003, 1007-1011, 3000-4999)
        // Code 1006 is reserved and cannot be sent programmatically
        const safeCode = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999) ? code : 1011;
        clientWs.close(safeCode, reason.toString() || "CAD connection closed");
      }
    });
    
    cadWs.on("error", (err) => {
      console.error("[CAD-WS] CAD WebSocket error:", err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, "CAD connection error");
      }
    });
    
    // Forward messages from client to CAD (if needed)
    clientWs.on("message", (data) => {
      if (cadWs.readyState === WebSocket.OPEN) {
        cadWs.send(data.toString());
      }
    });
    
    clientWs.on("close", () => {
      console.log("[CAD-WS] Client disconnected");
      if (cadWs.readyState === WebSocket.OPEN) {
        cadWs.close();
      }
    });
    
    clientWs.on("error", (err) => {
      console.error("[CAD-WS] Client WebSocket error:", err.message);
      if (cadWs.readyState === WebSocket.OPEN) {
        cadWs.close();
      }
    });
  });

  return httpServer;
}
