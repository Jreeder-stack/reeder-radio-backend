import express from "express";
import cors from "cors";
import { AccessToken } from "@livekit/server-sdk";

const app = express();
app.use(cors());

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET; // THIS MUST BE YOUR PRIVATE KEY (LKCP...)
const livekitUrl = process.env.LIVEKIT_URL;

app.get("/getToken", async (req, res) => {
  const identity = req.query.identity;
  const roomName = req.query.room;

  if (!identity || !roomName) {
    return res.status(400).json({ error: "Missing identity or room" });
  }

  try {
    const at = new AccessToken(apiKey, apiSecret, {
      identity,
    });

    at.addGrant({
      room: roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });

    const token = await at.toJwt();

    res.json({ token });
  } catch (err) {
    console.error("Token error:", err);
    res.status(500).json({ error: "Token creation failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("LiveKit Token Server running on port", port);
});
