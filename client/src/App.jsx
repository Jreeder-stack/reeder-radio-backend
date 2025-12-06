import { useState, useRef, useEffect, useCallback } from "react";
import { Room, RoomEvent, createLocalAudioTrack, DataPacket_Kind } from "livekit-client";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;
const TOKEN_SERVER = "/getToken";

const ZONES = {
  "Zone 1 - Operations": ["OPS1", "OPS2", "TAC1"],
  "Zone 2 - Fire": ["FIRE1", "FIRE2", "FIRE3", "FIRE4", "FIRE5", "FIRE6", "FIRE7", "FIRE8"],
  "Zone 3 - Secure Command": ["SECURE_CMD"],
};

const STATUS_COLORS = {
  idle: "#22c55e",
  transmitting: "#eab308",
  emergency: "#dc2626",
};

function formatTimestamp(ts) {
  if (!ts) return "";
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function StatusDot({ status }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        backgroundColor: STATUS_COLORS[status] || STATUS_COLORS.idle,
        marginRight: 6,
        boxShadow: status === "transmitting" ? "0 0 6px #eab308" : "none",
      }}
    />
  );
}

export default function App() {
  const [connected, setConnected] = useState(false);
  const [identity, setIdentity] = useState("");
  const [selectedZone, setSelectedZone] = useState("Zone 1 - Operations");
  const [selectedChannel, setSelectedChannel] = useState("OPS1");
  const [transmitChannel, setTransmitChannel] = useState("OPS1");
  const [primaryRoom, setPrimaryRoom] = useState(null);
  const [scanRooms, setScanRooms] = useState({});
  const [unitPresence, setUnitPresence] = useState({});
  const [isTalking, setIsTalking] = useState(false);
  const [scanMode, setScanMode] = useState(false);
  const [scanChannels, setScanChannels] = useState([]);
  const [activeAudio, setActiveAudio] = useState(null);

  const audioTrackRef = useRef(null);
  const scanRoomsRef = useRef({});
  const primaryRoomRef = useRef(null);

  useEffect(() => {
    scanRoomsRef.current = scanRooms;
  }, [scanRooms]);

  useEffect(() => {
    primaryRoomRef.current = primaryRoom;
  }, [primaryRoom]);

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
        setUnitPresence((prev) => {
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

  const broadcastStatus = useCallback((room, status, channel) => {
    if (!room || !room.localParticipant) return;
    
    const message = JSON.stringify({
      type: "status_update",
      identity: room.localParticipant.identity,
      status,
      channel,
      timestamp: Date.now(),
    });
    
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    room.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
  }, []);

  const updateUnitPresence = useCallback((channel, unitId, status, timestamp) => {
    setUnitPresence((prev) => {
      const channelUnits = prev[channel] || {};
      const existingUnit = channelUnits[unitId] || {};
      return {
        ...prev,
        [channel]: {
          ...channelUnits,
          [unitId]: {
            status,
            lastTransmission: status === "transmitting" ? timestamp : existingUnit.lastTransmission,
            lastSeen: timestamp,
          },
        },
      };
    });
  }, []);

  const getToken = async (room) => {
    const res = await fetch(`${TOKEN_SERVER}?identity=${identity}&room=${room}`);
    const data = await res.json();
    return data.token;
  };

  const createRoom = useCallback((channelName) => {
    const lkRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    lkRoom.on(RoomEvent.ParticipantConnected, (participant) => {
      updateUnitPresence(channelName, participant.identity, "idle", Date.now());
    });

    lkRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      setUnitPresence((prev) => {
        const channelUnits = { ...(prev[channelName] || {}) };
        delete channelUnits[participant.identity];
        return {
          ...prev,
          [channelName]: channelUnits,
        };
      });
    });

    lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === "audio") {
        const audioElem = track.attach();
        audioElem.dataset.channel = channelName;
        audioElem.dataset.participant = participant.identity;
        document.body.appendChild(audioElem);
        setActiveAudio({ channel: channelName, from: participant.identity });
        updateUnitPresence(channelName, participant.identity, "transmitting", Date.now());
      }
    });

    lkRoom.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      track.detach().forEach((el) => el.remove());
      setActiveAudio(null);
      updateUnitPresence(channelName, participant.identity, "idle", Date.now());
    });

    lkRoom.on(RoomEvent.DataReceived, (payload, participant) => {
      try {
        const decoder = new TextDecoder();
        const message = JSON.parse(decoder.decode(payload));
        
        if (message.type === "status_update") {
          updateUnitPresence(message.channel, message.identity, message.status, message.timestamp);
        }
      } catch (err) {
        console.error("Error parsing data message:", err);
      }
    });

    return lkRoom;
  }, [updateUnitPresence]);

  const initializePresence = useCallback((room, channelName) => {
    const existingParticipants = Array.from(room.remoteParticipants.values());
    const channelPresence = {};
    
    existingParticipants.forEach((p) => {
      const isPublishing = Array.from(p.audioTrackPublications.values()).some(
        (pub) => pub.track && !pub.isMuted
      );
      channelPresence[p.identity] = {
        status: isPublishing ? "transmitting" : "idle",
        lastTransmission: null,
        lastSeen: Date.now(),
      };
    });

    setUnitPresence((prev) => ({
      ...prev,
      [channelName]: channelPresence,
    }));
  }, []);

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

      initializePresence(lkRoom, selectedChannel);

      setPrimaryRoom(lkRoom);
      setTransmitChannel(selectedChannel);
      setConnected(true);

      broadcastStatus(lkRoom, "idle", selectedChannel);

    } catch (err) {
      console.error("Connection error:", err);
      alert("Failed to connect: " + err.message);
    }
  };

  const switchChannel = async (newChannel) => {
    if (!connected || newChannel === selectedChannel) return;

    try {
      if (primaryRoomRef.current) {
        await primaryRoomRef.current.disconnect();
      }

      const token = await getToken(newChannel);
      const lkRoom = createRoom(newChannel);
      await lkRoom.connect(LIVEKIT_URL, token);

      initializePresence(lkRoom, newChannel);

      setPrimaryRoom(lkRoom);
      setSelectedChannel(newChannel);
      setTransmitChannel(newChannel);

      broadcastStatus(lkRoom, "idle", newChannel);

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
      setUnitPresence((prev) => {
        const updated = { ...prev };
        delete updated[channel];
        return updated;
      });
    } else {
      try {
        const token = await getToken(channel);
        const lkRoom = createRoom(channel);
        await lkRoom.connect(LIVEKIT_URL, token);

        initializePresence(lkRoom, channel);

        setScanRooms((prev) => ({ ...prev, [channel]: lkRoom }));
        setScanChannels((prev) => [...prev, channel]);
      } catch (err) {
        console.error("Scan channel error:", err);
      }
    }
  };

  const startPTT = async () => {
    if (!primaryRoomRef.current) return;

    try {
      setIsTalking(true);
      const micTrack = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
      });
      audioTrackRef.current = micTrack;

      await primaryRoomRef.current.localParticipant.publishTrack(micTrack);
      broadcastStatus(primaryRoomRef.current, "transmitting", transmitChannel);
    } catch (err) {
      console.error("PTT error:", err);
      setIsTalking(false);
    }
  };

  const stopPTT = async () => {
    if (!primaryRoomRef.current || !audioTrackRef.current) return;

    try {
      await primaryRoomRef.current.localParticipant.unpublishTrack(audioTrackRef.current);
      audioTrackRef.current.stop();
      audioTrackRef.current = null;
      setIsTalking(false);
      broadcastStatus(primaryRoomRef.current, "idle", transmitChannel);
    } catch (err) {
      console.error("Stop PTT error:", err);
      setIsTalking(false);
    }
  };

  const disconnect = async () => {
    if (primaryRoomRef.current) {
      await primaryRoomRef.current.disconnect();
    }

    for (const room of Object.values(scanRoomsRef.current)) {
      await room.disconnect();
    }

    setPrimaryRoom(null);
    setScanRooms({});
    setScanChannels([]);
    setConnected(false);
    setUnitPresence({});
    setScanMode(false);
  };

  const currentZoneChannels = ZONES[selectedZone] || [];
  
  const totalUnits = Object.values(unitPresence).reduce(
    (sum, channelUnits) => sum + Object.keys(channelUnits).length,
    0
  );

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
              <p style={{ margin: "4px 0", opacity: 0.7, fontSize: 14 }}>
                <StatusDot status={isTalking ? "transmitting" : "idle"} />
                Unit: {identity}
              </p>
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
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
            }}>
              <StatusDot status="transmitting" />
              Receiving: {activeAudio.from} on {activeAudio.channel}
            </div>
          )}

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            marginBottom: 16,
            maxHeight: 180,
            overflowY: "auto",
          }}>
            <h3 style={{ margin: "0 0 8px 0", fontSize: 14 }}>
              Online Units ({totalUnits})
            </h3>
            {Object.entries(unitPresence).map(([channel, units]) => (
              Object.keys(units).length > 0 && (
                <div key={channel} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{channel}</div>
                  {Object.entries(units).map(([unitId, info]) => (
                    <div 
                      key={unitId} 
                      style={{ 
                        fontSize: 12, 
                        marginBottom: 2,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "4px 8px",
                        background: info.status === "transmitting" ? "rgba(234, 179, 8, 0.1)" : "transparent",
                        borderRadius: 4,
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center" }}>
                        <StatusDot status={info.status} />
                        {unitId}
                      </span>
                      {info.lastTransmission && (
                        <span style={{ fontSize: 10, opacity: 0.5 }}>
                          TX: {formatTimestamp(info.lastTransmission)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )
            ))}
            {totalUnits === 0 && (
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
