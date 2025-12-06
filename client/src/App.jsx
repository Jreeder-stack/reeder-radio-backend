import { useState, useRef, useEffect } from "react";
import { Room, RoomEvent, createLocalAudioTrack } from "livekit-client";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;
const TOKEN_SERVER = "/getToken";

const ZONES = {
  "Zone 1 - Operations": ["OPS1", "OPS2", "TAC1"],
  "Zone 2 - Fire": ["FIRE1", "FIRE2", "FIRE3", "FIRE4", "FIRE5", "FIRE6", "FIRE7", "FIRE8"],
  "Zone 3 - Secure Command": ["SECURE_CMD"],
};

export default function App() {
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState("");
  const [selectedZone, setSelectedZone] = useState("Zone 1 - Operations");
  const [selectedChannel, setSelectedChannel] = useState("OPS1");
  const [transmitChannel, setTransmitChannel] = useState("OPS1");
  const [primaryRoom, setPrimaryRoom] = useState(null);
  const [scanRooms, setScanRooms] = useState({});
  const [onlineUnits, setOnlineUnits] = useState({});
  const [isTalking, setIsTalking] = useState(false);
  const [scanMode, setScanMode] = useState(false);
  const [scanChannels, setScanChannels] = useState([]);
  const [activeAudio, setActiveAudio] = useState(null);

  const audioTrackRef = useRef(null);
  const scanRoomsRef = useRef({});

  useEffect(() => {
    scanRoomsRef.current = scanRooms;
  }, [scanRooms]);

  useEffect(() => {
    if (!scanMode && Object.keys(scanRoomsRef.current).length > 0) {
      const disconnectAll = async () => {
        for (const [channel, room] of Object.entries(scanRoomsRef.current)) {
          try {
            await room.disconnect();
          } catch (err) {
            console.error("Error disconnecting scan room:", err);
          }
        }
        setScanRooms({});
        setScanChannels([]);
        setOnlineUnits((prev) => {
          const updated = { ...prev };
          for (const channel of Object.keys(scanRoomsRef.current)) {
            delete updated[channel];
          }
          return updated;
        });
      };
      disconnectAll();
    }
  }, [scanMode]);

  const getToken = async (room) => {
    const res = await fetch(`${TOKEN_SERVER}?identity=${identity}&room=${room}`);
    const data = await res.json();
    return data.token;
  };

  const createRoom = (channelName) => {
    const lkRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    lkRoom.on(RoomEvent.ParticipantConnected, (participant) => {
      setOnlineUnits((prev) => ({
        ...prev,
        [channelName]: [...(prev[channelName] || []), participant.identity],
      }));
    });

    lkRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      setOnlineUnits((prev) => ({
        ...prev,
        [channelName]: (prev[channelName] || []).filter((u) => u !== participant.identity),
      }));
    });

    lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === "audio") {
        const audioElem = track.attach();
        audioElem.dataset.channel = channelName;
        audioElem.dataset.participant = participant.identity;
        document.body.appendChild(audioElem);
        setActiveAudio({ channel: channelName, from: participant.identity });
      }
    });

    lkRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
      setActiveAudio(null);
    });

    return lkRoom;
  };

  const connectToChannel = async () => {
    try {
      if (!identity) {
        alert("Enter your Unit ID");
        return;
      }

      const token = await getToken(selectedChannel);
      if (!token) {
        alert("Invalid token received from backend.");
        return;
      }

      const lkRoom = createRoom(selectedChannel);
      await lkRoom.connect(LIVEKIT_URL, token);

      const existingParticipants = Array.from(lkRoom.remoteParticipants.values()).map(
        (p) => p.identity
      );
      setOnlineUnits({ [selectedChannel]: existingParticipants });

      setPrimaryRoom(lkRoom);
      setTransmitChannel(selectedChannel);
      setConnected(true);

    } catch (err) {
      console.error("Connection error:", err);
      alert("Failed to connect: " + err.message);
    }
  };

  const switchChannel = async (newChannel) => {
    if (!connected || newChannel === selectedChannel) return;

    try {
      if (primaryRoom) {
        await primaryRoom.disconnect();
      }

      const token = await getToken(newChannel);
      const lkRoom = createRoom(newChannel);
      await lkRoom.connect(LIVEKIT_URL, token);

      const existingParticipants = Array.from(lkRoom.remoteParticipants.values()).map(
        (p) => p.identity
      );
      
      setOnlineUnits((prev) => ({
        ...prev,
        [newChannel]: existingParticipants,
      }));

      setPrimaryRoom(lkRoom);
      setSelectedChannel(newChannel);
      setTransmitChannel(newChannel);

    } catch (err) {
      console.error("Switch channel error:", err);
      alert("Failed to switch channel: " + err.message);
    }
  };

  const toggleScanChannel = async (channel) => {
    if (channel === selectedChannel) return;

    if (scanChannels.includes(channel)) {
      if (scanRooms[channel]) {
        await scanRooms[channel].disconnect();
        setScanRooms((prev) => {
          const updated = { ...prev };
          delete updated[channel];
          return updated;
        });
      }
      setScanChannels((prev) => prev.filter((c) => c !== channel));
      setOnlineUnits((prev) => {
        const updated = { ...prev };
        delete updated[channel];
        return updated;
      });
    } else {
      try {
        const token = await getToken(channel);
        const lkRoom = createRoom(channel);
        await lkRoom.connect(LIVEKIT_URL, token);

        const existingParticipants = Array.from(lkRoom.remoteParticipants.values()).map(
          (p) => p.identity
        );

        setScanRooms((prev) => ({ ...prev, [channel]: lkRoom }));
        setScanChannels((prev) => [...prev, channel]);
        setOnlineUnits((prev) => ({
          ...prev,
          [channel]: existingParticipants,
        }));
      } catch (err) {
        console.error("Scan channel error:", err);
      }
    }
  };

  const startPTT = async () => {
    if (!primaryRoom) return;

    try {
      setIsTalking(true);
      const micTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
      });
      audioTrackRef.current = micTrack;

      await primaryRoom.localParticipant.publishTrack(micTrack);
    } catch (err) {
      console.error("PTT error:", err);
      setIsTalking(false);
    }
  };

  const stopPTT = async () => {
    if (!primaryRoom || !audioTrackRef.current) return;

    try {
      await primaryRoom.localParticipant.unpublishTrack(audioTrackRef.current);
      audioTrackRef.current.stop();
      audioTrackRef.current = null;
      setIsTalking(false);
    } catch (err) {
      console.error("Stop PTT error:", err);
      setIsTalking(false);
    }
  };

  const disconnect = async () => {
    if (primaryRoom) {
      await primaryRoom.disconnect();
    }

    for (const room of Object.values(scanRooms)) {
      await room.disconnect();
    }

    setPrimaryRoom(null);
    setScanRooms({});
    setScanChannels([]);
    setConnected(false);
    setOnlineUnits({});
    setScanMode(false);
  };

  const currentZoneChannels = ZONES[selectedZone] || [];

  return (
    <div style={{
      padding: 20,
      fontFamily: "sans-serif",
      color: "white",
      background: "#0a0a0a",
      minHeight: "100vh"
    }}>
      <h1 style={{ fontSize: 24, marginBottom: 20 }}>Reeder PTT Radio</h1>

      {!connected ? (
        <div>
          <label>Unit ID:</label>
          <input
            style={{ width: "100%", padding: 10, marginTop: 4, boxSizing: "border-box", borderRadius: 6 }}
            value={identity}
            onChange={(e) => setIdentity(e.target.value)}
            placeholder="Unit52"
          />

          <label style={{ display: "block", marginTop: 16 }}>Zone:</label>
          <select
            style={{ width: "100%", padding: 10, boxSizing: "border-box", borderRadius: 6 }}
            value={selectedZone}
            onChange={(e) => {
              setSelectedZone(e.target.value);
              setSelectedChannel(ZONES[e.target.value][0]);
            }}
          >
            {Object.keys(ZONES).map((zone) => (
              <option key={zone} value={zone}>{zone}</option>
            ))}
          </select>

          <label style={{ display: "block", marginTop: 16 }}>Channel:</label>
          <select
            style={{ width: "100%", padding: 10, boxSizing: "border-box", borderRadius: 6 }}
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
          >
            {currentZoneChannels.map((ch) => (
              <option key={ch} value={ch}>{ch}</option>
            ))}
          </select>

          <button
            onClick={connectToChannel}
            style={{
              marginTop: 24,
              padding: 14,
              width: "100%",
              backgroundColor: "#22c55e",
              color: "white",
              border: "none",
              borderRadius: 8,
              fontSize: 16,
              fontWeight: "bold",
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
            marginBottom: 16
          }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.6 }}>{selectedZone}</div>
              <h2 style={{ margin: 0, fontSize: 22 }}>{selectedChannel}</h2>
              <p style={{ margin: "4px 0", opacity: 0.7, fontSize: 14 }}>Unit: {identity}</p>
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
            display: "flex", 
            gap: 8, 
            marginBottom: 16,
            flexWrap: "wrap"
          }}>
            {currentZoneChannels.map((ch) => (
              <button
                key={ch}
                onClick={() => switchChannel(ch)}
                style={{
                  padding: "8px 12px",
                  backgroundColor: ch === selectedChannel ? "#3b82f6" : "#333",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {ch}
              </button>
            ))}
          </div>

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            marginBottom: 16
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Scan Mode</h3>
              <button
                onClick={() => setScanMode(!scanMode)}
                style={{
                  padding: "4px 12px",
                  backgroundColor: scanMode ? "#f59e0b" : "#444",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {scanMode ? "ON" : "OFF"}
              </button>
            </div>
            
            {scanMode && (
              <div style={{ marginTop: 8 }}>
                <p style={{ fontSize: 12, opacity: 0.6, margin: "0 0 8px 0" }}>
                  Select channels to monitor (TX on {transmitChannel}):
                </p>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {currentZoneChannels.filter(ch => ch !== selectedChannel).map((ch) => (
                    <button
                      key={ch}
                      onClick={() => toggleScanChannel(ch)}
                      style={{
                        padding: "4px 8px",
                        backgroundColor: scanChannels.includes(ch) ? "#22c55e" : "#333",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      {ch}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {activeAudio && (
            <div style={{
              background: "#1e40af",
              padding: 10,
              borderRadius: 8,
              marginBottom: 16,
              textAlign: "center",
              fontSize: 14,
            }}>
              Receiving: {activeAudio.from} on {activeAudio.channel}
            </div>
          )}

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            marginBottom: 16,
            maxHeight: 120,
            overflowY: "auto",
          }}>
            <h3 style={{ margin: "0 0 8px 0", fontSize: 14 }}>
              Online Units ({Object.values(onlineUnits).flat().length})
            </h3>
            {Object.entries(onlineUnits).map(([channel, units]) => (
              units.length > 0 && (
                <div key={channel} style={{ fontSize: 12, marginBottom: 4 }}>
                  <span style={{ opacity: 0.6 }}>{channel}:</span> {units.join(", ")}
                </div>
              )
            ))}
            {Object.values(onlineUnits).flat().length === 0 && (
              <p style={{ opacity: 0.5, margin: 0, fontSize: 12 }}>No other units online</p>
            )}
          </div>

          <div style={{ 
            background: "#1a1a1a", 
            padding: 8, 
            borderRadius: 8,
            marginBottom: 16,
            textAlign: "center",
            fontSize: 12,
          }}>
            TX: {transmitChannel} | RX: {[selectedChannel, ...scanChannels].join(", ")}
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
              fontSize: 22,
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
