import { useState, useRef } from "react";
import * as LiveKit from "livekit-client";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;
const TOKEN_SERVER = "/getToken";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState("");
  const [roomName, setRoomName] = useState("OPS1");
  const [room, setRoom] = useState(null);
  const [onlineUnits, setOnlineUnits] = useState([]);

  const audioTrackRef = useRef(null);

  const connectToChannel = async () => {
    try {
      if (!identity) {
        alert("Enter your Unit ID");
        return;
      }

      // 🔑 Get token from your Render backend
      const res = await fetch(
        `${TOKEN_SERVER}?identity=${identity}&room=${roomName}`
      );

      const data = await res.json();
      const token = data.token;

      if (!token || !token.startsWith("lk1_")) {
        console.error("Invalid token:", data);
        alert("Invalid token received from backend.");
        return;
      }

      // 🛰️ Connect to LiveKit cloud
      const lkRoom = await LiveKit.connect(LIVEKIT_URL, token, {
        autoSubscribe: true,
      });

      setRoom(lkRoom);
      setConnected(true);

      // Track other units
      lkRoom.on("participantConnected", (p) => {
        setOnlineUnits((prev) => [...prev, p.identity]);
      });

      lkRoom.on("participantDisconnected", (p) => {
        setOnlineUnits((prev) =>
          prev.filter((unit) => unit !== p.identity)
        );
      });

      // Play incoming audio
      lkRoom.on("trackSubscribed", (track) => {
        if (track.kind === "audio") {
          const audioElem = new Audio();
          audioElem.srcObject = new MediaStream([track.mediaStreamTrack]);
          audioElem.play();
        }
      });

    } catch (err) {
      console.error("Connection error:", err);
      alert("Failed to connect.");
    }
  };

  const startPTT = async () => {
    if (!room) return;

    // Turn on microphone
    const micTrack = await LiveKit.createLocalAudioTrack();
    audioTrackRef.current = micTrack;

    await room.localParticipant.publishTrack(micTrack);
  };

  const stopPTT = async () => {
    if (!room || !audioTrackRef.current) return;

    // Stop transmitting
    await room.localParticipant.unpublishTrack(audioTrackRef.current);
    audioTrackRef.current.stop();
    audioTrackRef.current = null;
  };

  return (
    <div style={{
      padding: 20,
      fontFamily: "sans-serif",
      color: "white",
      background: "#0a0a0a",
      height: "100vh"
    }}>
      <h1>🚔 Reeder PTT (Cloud)</h1>

      {!connected ? (
        <div>
          <label>Unit ID:</label>
          <input
            style={{ width: "100%", padding: 8, marginTop: 4 }}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder="Unit52"
          />

          <label style={{ display: "block", marginTop: 12 }}>Channel:</label>
          <select
            style={{ width: "100%", padding: 8 }}
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
          >
            <option value="OPS1">OPS 1</option>
            <option value="OPS2">OPS 2</option>
            <option value="TAC1">TAC 1</option>
            <option value="TAC2">TAC 2</option>
          </select>

          <button
            onClick={connectToChannel}
            style={{
              marginTop: 20,
              padding: 12,
              width: "100%",
              backgroundColor: "green",
              color: "white",
            }}
          >
            Connect
          </button>
        </div>
      ) : (
        <div>
          <h2>Connected to {roomName}</h2>
          <p>Logged in as {identity}</p>

          <h3>Online Units</h3>
          <ul>
            {onlineUnits.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>

          <button
            onMouseDown={startPTT}
            onMouseUp={stopPTT}
            onTouchStart={startPTT}
            onTouchEnd={stopPTT}
            style={{
              marginTop: 30,
              padding: 25,
              width: "100%",
              backgroundColor: "red",
              color: "white",
              fontSize: 22,
              borderRadius: 12,
            }}
          >
            PUSH TO TALK
          </button>
        </div>
      )}
    </div>
  );
}
