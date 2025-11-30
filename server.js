import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { SignJWT } from "jose";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const apiKey = process.env.LIVEKIT_API_KEY;
const apiSecret = process.env.LIVEKIT_API_SECRET;
const livekitUrl = process.env.LIVEKIT_URL;

if (!apiKey || !apiSecret || !livekitUrl) {
  console.error("Missing LIVEKIT environment variables");
  process.exit(1);
}

app.get("/", (req, res) => {
  res.send("Reeder Radio Backend is running");
});

// Generate JWT token manually
app.get("/getToken", async (req, res) => {
  try {
    const identity = req.query.identity;
    const room = req.query.room;

    if (!identity || !room) {
      return res.status(400).json({ error: "Missing identity or room" });
    }

    // JWT Header
    const header = {
      alg: "HS256",
      typ: "JWT",
      kid: apiKey,
    };

    // JWT Payload
    const payload = {
      iss: apiKey,
      sub: identity,
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour
      video: {
        room,
        allow_publish: true,
        allow_subscribe: true,
      },
    };

    const secret = new TextEncoder().encode(apiSecret);

    const token = await new SignJWT(payload)
      .setProtectedHeader(header)
      .sign(secret);

    return res.json({ token });
  } catch (err) {
    console.error("Error generating token:", err);
    return res.status(500).json({ error: "Token generation failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Reeder Token Server running on port ${port}`);
});