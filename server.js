const express = require("express");
const cors = require("cors");
const { AccessToken } = require("livekit-server-sdk");

const app = express();
app.use(express.json());
app.use(cors());

// LiveKit dev credentials - these match livekit-server.exe --dev
const API_KEY = "devkey";
const API_SECRET = "secret";
const LIVEKIT_URL = "ws://localhost:7880";

app.post("/getToken", async (req, res) => {
  try {
    const { identity, room } = req.body;

    if (!identity || !room) {
      console.error("Missing identity or room", req.body);
      return res.status(400).json({ error: "identity and room required" });
    }

    // Build access token for this user
    const at = new AccessToken(API_KEY, API_SECRET, { identity });

    at.addGrant({
      room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    // toJwt() is async in this SDK version
    const jwt = await at.toJwt();

    console.log("jwt typeof:", typeof jwt);
    console.log("jwt preview:", String(jwt).slice(0, 40) + "...");

    return res.json({
      token: jwt,
      url: LIVEKIT_URL,
    });
  } catch (err) {
    console.error("Error generating token:", err);
    return res.status(500).json({ error: "token generation failed" });
  }
});

app.listen(3000, () => {
  console.log("Reeder Token Server running on port 3000");
});
