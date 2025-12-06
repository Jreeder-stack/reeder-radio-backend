// server.js
import express from "express";
import cors from "cors";
import { AccessToken } from "livekit-server-sdk"; // correct modern import
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;

console.log("Loaded LiveKit Config:", {
  LIVEKIT_URL,
  LIVEKIT_API_KEY,
  secretPresent: !!LIVEKIT_API_SECRET,
});

// -----------------------------
// TOKEN ENDPOINT
// -----------------------------
app.get("/getToken", async (req, res) => {
  try {
    const identity = req.query.identity;
    const room = req.query.room;

    if (!identity || !room) {
      return res.status(400).json({ error: "Missing identity or room" });
    }

    // Create Token
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity,
    });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    return res.json({ token });
  } catch (err) {
    console.error("Token Error:", err);
    return res.status(500).json({ error: "Failed to generate token" });
  }
});

const port = process.env.PORT || 3001;
app.listen(port, "localhost", () => {
  console.log(`Reeder Token Server running on localhost:${port}`);
});
