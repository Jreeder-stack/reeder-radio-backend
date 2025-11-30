import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { AccessToken } from "livekit-server-sdk";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Debug logging
console.log("LiveKit URL:", process.env.LIVEKIT_URL);
console.log("API Key:", process.env.LIVEKIT_API_KEY);
console.log("API Secret Loaded:", !!process.env.LIVEKIT_API_SECRET);

// --- TOKEN ENDPOINT ---
app.get("/getToken", async (req, res) => {
    try {
        const identity = req.query.identity || "UnknownUser";
        const roomName = req.query.room || "default";

        const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
            identity,
        });

        at.addGrant({
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true
        });

        const token = await at.toJwt();

        res.json({ token });
    } catch (err) {
        console.error("Token generation error:", err);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

// --- HEALTH CHECK ---
app.get("/", (req, res) => {
    res.send("Reeder PTT Backend is running.");
});

app.listen(PORT, () => {
    console.log(`Reeder Token Server running on port ${PORT}`);
});
