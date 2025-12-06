import { useState, useRef } from "react";
import { Room, RoomEvent, createLocalAudioTrack } from "livekit-client";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;
const TOKEN_SERVER = "/getToken";

export default function App() {
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState("");
  const [roomName, setRoomName] = useState("OPS1");
  const [room, setRoom] = useState(null);
  const [onlineUnits, setOnlineUnits] = useState([]);
  const [isTalking, setIsTalking] = useState(false);

  const audioTrackRef = useRef(null);

  const connectToChannel = async () => {
    try {
      if (!identity) {
        alert("Enter your Unit ID");
        return;
      }

      const res = await fetch(
        `${TOKEN_SERVER}?identity=${identity}&room=${roomName}`
      );

      const data = await res.json();
      const token = data.token;

      if (!token) {
        console.error("Invalid token:", data);
        alert("Invalid token received from backend.");
        return;
      }

      const lkRoom = new Room({
        adaptiveStream: true,
        dynacast: true,
      });

      lkRoom.on(RoomEvent.ParticipantConnected, (participant) => {
        setOnlineUnits((prev) => [...prev, participant.identity]);
      });

      lkRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
        setOnlineUnits((prev) =>
          prev.filter((unit) => unit !== participant.identity)
        );
      });

      lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (track.kind === "audio") {
          const audioElem = track.attach();
          document.body.appendChild(audioElem);
        }
      });

      lkRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => el.remove());
      });

      await lkRoom.connect(LIVEKIT_URL, token);

      const existingParticipants = Array.from(lkRoom.remoteParticipants.values()).map(
        (p) => p.identity
      );
      setOnlineUnits(existingParticipants);

      setRoom(lkRoom);
      setConnected(true);

    } catch (err) {
      console.error("Connection error:", err);
      alert("Failed to connect: " + err.message);
    }
  };

  const startPTT = async () => {
    if (!room) return;

    try {
      setIsTalking(true);
      const micTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
      });
      audioTrackRef.current = micTrack;

      await room.localParticipant.publishTrack(micTrack);
    } catch (err) {
      console.error("PTT error:", err);
      setIsTalking(false);
    }
  };

  const stopPTT = async () => {
    if (!room || !audioTrackRef.current) return;

    try {
      await room.localParticipant.unpublishTrack(audioTrackRef.current);
      audioTrackRef.current.stop();
      audioTrackRef.current = null;
      setIsTalking(false);
    } catch (err) {
      console.error("Stop PTT error:", err);
      setIsTalking(false);
    }
  };

  const disconnect = async () => {
    if (room) {
      await room.disconnect();
      setRoom(null);
      setConnected(false);
      setOnlineUnits([]);
    }
  };

  return (
    <div style={{
      padding: 20,
      fontFamily: "sans-serif",
      color: "white",
      background: "#0a0a0a",
      minHeight: "100vh"
    }}>
      <h1>Reeder PTT Radio</h1>

      {!connected ? (
        <div>
          <label>Unit ID:</label>
          <input
            style={{ width: "100%", padding: 8, marginTop: 4, boxSizing: "border-box" }}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder="Unit52"
          />

          <label style={{ display: "block", marginTop: 12 }}>Channel:</label>
          <select
            style={{ width: "100%", padding: 8, boxSizing: "border-box" }}
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
              backgroundColor: "#22c55e",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            Connect
          </button>
        </div>
      ) : (
        <div>
          <div style={{ 
            display: "flex", 
            justifyContent: "space-between", 
            alignItems: "center",
            marginBottom: 20 
          }}>
            <div>
              <h2 style={{ margin: 0 }}>{roomName}</h2>
              <p style={{ margin: "4px 0", opacity: 0.7 }}>Logged in as {identity}</p>
            </div>
            <button
              onClick={disconnect}
              style={{
                padding: "8px 16px",
                backgroundColor: "#666",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
              }}
            >
              Disconnect
            </button>
          </div>

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            marginBottom: 20 
          }}>
            <h3 style={{ margin: "0 0 8px 0" }}>Online Units ({onlineUnits.length})</h3>
            {onlineUnits.length === 0 ? (
              <p style={{ opacity: 0.5, margin: 0 }}>No other units online</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {onlineUnits.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            )}
          </div>

          <button
            onMouseDown={startPTT}
            onMouseUp={stopPTT}
            onMouseLeave={stopPTT}
            onTouchStart={startPTT}
            onTouchEnd={stopPTT}
            style={{
              padding: 30,
              width: "100%",
              backgroundColor: isTalking ? "#dc2626" : "#b91c1c",
              color: "white",
              fontSize: 24,
              fontWeight: "bold",
              border: "none",
              borderRadius: 12,
              cursor: "pointer",
              boxShadow: isTalking ? "0 0 30px rgba(220, 38, 38, 0.6)" : "none",
              transition: "all 0.1s ease",
            }}
          >
            {isTalking ? "TRANSMITTING..." : "PUSH TO TALK"}
          </button>
        </div>
      )}
    </div>
  );
}
