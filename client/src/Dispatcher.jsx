import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Room, RoomEvent, Track, DataPacket_Kind } from "livekit-client";

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;
const TOKEN_SERVER = "/getToken";

// Track audio elements that have already been connected to a MediaElementSource
// This prevents the "HTMLMediaElement already connected" error on reconnection
const connectedAudioElements = new WeakMap();

function clearAudioElementFromCache(audioElement) {
  connectedAudioElements.delete(audioElement);
}

function getOrCreateMediaElementSource(audioContext, audioElement, track) {
  // Check if this audio element already has a source
  if (connectedAudioElements.has(audioElement)) {
    const cachedSource = connectedAudioElements.get(audioElement);
    // Verify the cached source's context is still the same and not closed
    if (cachedSource.context === audioContext && audioContext.state !== "closed") {
      return { source: cachedSource, element: audioElement };
    }
    // Context changed or closed - properly detach and create fresh element
    console.log("AudioContext changed, detaching and creating fresh audio element");
    try {
      track.detach(audioElement);
    } catch (e) {
      console.warn("Could not detach old element:", e.message);
    }
    audioElement.remove();
    connectedAudioElements.delete(audioElement);
  }
  
  // Try to create source for the provided element first
  try {
    const source = audioContext.createMediaElementSource(audioElement);
    connectedAudioElements.set(audioElement, source);
    return { source, element: audioElement };
  } catch (err) {
    // Element might already be connected - try with a completely fresh Audio element
    console.log("Element already connected, trying with fresh Audio element");
    try {
      track.detach(audioElement);
    } catch (e) {
      // Ignore detach errors
    }
    audioElement.remove();
    connectedAudioElements.delete(audioElement);
    
    // Create a brand new Audio element
    const freshAudio = new Audio();
    freshAudio.autoplay = true;
    const freshElement = track.attach(freshAudio);
    
    try {
      const source = audioContext.createMediaElementSource(freshElement);
      connectedAudioElements.set(freshElement, source);
      return { source, element: freshElement };
    } catch (retryErr) {
      console.warn("Could not create MediaElementSource even with fresh element:", retryErr.message);
      // Last resort - return null but element still plays audio
      return { source: null, element: freshElement };
    }
  }
}

const ZONES = {
  "Zone 1 - Operations": ["OPS1", "OPS2", "TAC1"],
  "Zone 2 - Fire": ["FIRE1", "FIRE2", "FIRE3", "FIRE4", "FIRE5", "FIRE6", "FIRE7", "FIRE8"],
  "Zone 3 - Secure Command": ["SECURE_CMD"],
};

const ALL_CHANNELS = Object.values(ZONES).flat();

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
        boxShadow: status === "transmitting" ? "0 0 6px #eab308" : status === "emergency" ? "0 0 6px #dc2626" : "none",
      }}
    />
  );
}

function AudioLevelMeter({ level }) {
  const barCount = 8;
  const activeCount = Math.round((level / 100) * barCount);
  
  return (
    <div style={{ display: "flex", gap: 1, alignItems: "flex-end", height: 16 }}>
      {Array.from({ length: barCount }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 3,
            height: 3 + i * 1.5,
            backgroundColor: i < activeCount 
              ? (i >= 6 ? "#dc2626" : i >= 4 ? "#eab308" : "#22c55e")
              : "#333",
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

export default function Dispatcher({ user, onLogout }) {
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [dispatcherId, setDispatcherId] = useState(user?.username || "DISPATCH");
  const [channelRooms, setChannelRooms] = useState({});
  const [unitPresence, setUnitPresence] = useState({});
  const [activeEmergencies, setActiveEmergencies] = useState({});
  const [emergencyFlash, setEmergencyFlash] = useState(false);
  const [mutedChannels, setMutedChannels] = useState({});
  const [channelLevels, setChannelLevels] = useState({});
  const [activeTransmissions, setActiveTransmissions] = useState({});
  const [selectedTxChannel, setSelectedTxChannel] = useState("OPS1");
  const [isTalking, setIsTalking] = useState(false);
  const [lastRxRecordings, setLastRxRecordings] = useState({});
  const [playingChannel, setPlayingChannel] = useState(null);

  const channelRoomsRef = useRef({});
  const audioContextRef = useRef(null);
  const audioTrackRef = useRef(null);
  const micStreamRef = useRef(null);
  const levelAnimationsRef = useRef({});
  const recordersRef = useRef({});
  const recordedChunksRef = useRef({});

  useEffect(() => {
    channelRoomsRef.current = channelRooms;
  }, [channelRooms]);

  useEffect(() => {
    if (Object.keys(activeEmergencies).length > 0) {
      const flashInterval = setInterval(() => {
        setEmergencyFlash(f => !f);
      }, 500);
      return () => clearInterval(flashInterval);
    } else {
      setEmergencyFlash(false);
    }
  }, [activeEmergencies]);

  useEffect(() => {
    return () => {
      Object.values(levelAnimationsRef.current).forEach(id => cancelAnimationFrame(id));
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, []);

  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContextRef.current.state === "suspended") {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const getToken = async (room) => {
    const res = await fetch(`${TOKEN_SERVER}?identity=${dispatcherId}&room=${room}`);
    const data = await res.json();
    return data.token;
  };

  const updateUnitPresence = useCallback((channel, unitId, status, timestamp, location = null) => {
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
            location: location || existingUnit.location,
          },
        },
      };
    });
  }, []);

  const acknowledgeEmergency = useCallback((unitId, channel) => {
    setActiveEmergencies((prev) => {
      const updated = { ...prev };
      delete updated[unitId];
      return updated;
    });
    
    const room = channelRoomsRef.current[channel];
    if (room) {
      const message = JSON.stringify({
        type: "emergency_ack",
        targetUnit: unitId,
        channel,
        acknowledgedBy: dispatcherId,
        timestamp: Date.now(),
      });
      
      const encoder = new TextEncoder();
      const data = encoder.encode(message);
      room.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
    }
    
    updateUnitPresence(channel, unitId, "idle", Date.now());
  }, [dispatcherId, updateUnitPresence]);

  const createChannelRoom = useCallback((channelName) => {
    const lkRoom = new Room({
      adaptiveStream: true,
      dynacast: true,
    });

    lkRoom.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity !== dispatcherId) {
        updateUnitPresence(channelName, participant.identity, "idle", Date.now());
      }
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
      if (track.kind === "audio" && participant.identity !== dispatcherId) {
        const audioContext = getAudioContext();
        const audioElem = track.attach();
        audioElem.dataset.channel = channelName;
        audioElem.dataset.participant = participant.identity;
        audioElem.muted = mutedChannels[channelName] || false;
        
        // Use helper to prevent duplicate MediaElementSource connections
        const { source, element } = getOrCreateMediaElementSource(audioContext, audioElem, track);
        element.dataset.channel = channelName;
        element.dataset.participant = participant.identity;
        element.muted = mutedChannels[channelName] || false;
        
        // If source is null, we can't do audio processing but audio still plays through element
        if (!source) {
          setActiveTransmissions(prev => ({
            ...prev,
            [channelName]: { from: participant.identity, timestamp: Date.now() },
          }));
          updateUnitPresence(channelName, participant.identity, "transmitting", Date.now());
          return;
        }
        
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.3;
        
        const gainNode = audioContext.createGain();
        gainNode.gain.value = mutedChannels[channelName] ? 0 : 1;
        
        source.connect(analyser);
        analyser.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const updateLevel = () => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          setChannelLevels(prev => ({ ...prev, [channelName]: Math.min(100, avg * 1.5) }));
          levelAnimationsRef.current[channelName] = requestAnimationFrame(updateLevel);
        };
        updateLevel();
        
        recordedChunksRef.current[channelName] = [];
        const destNode = audioContext.createMediaStreamDestination();
        analyser.connect(destNode);
        
        try {
          const recorder = new MediaRecorder(destNode.stream);
          recorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              if (!recordedChunksRef.current[channelName]) {
                recordedChunksRef.current[channelName] = [];
              }
              recordedChunksRef.current[channelName].push(e.data);
            }
          };
          recorder.onstop = () => {
            if (recordedChunksRef.current[channelName]?.length > 0) {
              const blob = new Blob(recordedChunksRef.current[channelName], { type: "audio/webm" });
              setLastRxRecordings(prev => ({ ...prev, [channelName]: blob }));
            }
          };
          recorder.start();
          recordersRef.current[channelName] = recorder;
        } catch (err) {
          console.error("MediaRecorder error:", err);
        }
        
        setActiveTransmissions(prev => ({
          ...prev,
          [channelName]: { from: participant.identity, timestamp: Date.now() },
        }));
        updateUnitPresence(channelName, participant.identity, "transmitting", Date.now());
      }
    });

    lkRoom.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (levelAnimationsRef.current[channelName]) {
        cancelAnimationFrame(levelAnimationsRef.current[channelName]);
        delete levelAnimationsRef.current[channelName];
      }
      setChannelLevels(prev => ({ ...prev, [channelName]: 0 }));
      
      if (recordersRef.current[channelName] && recordersRef.current[channelName].state !== "inactive") {
        recordersRef.current[channelName].stop();
        delete recordersRef.current[channelName];
      }
      
      track.detach().forEach((el) => {
        clearAudioElementFromCache(el);
        el.remove();
      });
      setActiveTransmissions(prev => {
        const updated = { ...prev };
        delete updated[channelName];
        return updated;
      });
      updateUnitPresence(channelName, participant.identity, "idle", Date.now());
    });

    lkRoom.on(RoomEvent.DataReceived, (payload, participant) => {
      try {
        const decoder = new TextDecoder();
        const message = JSON.parse(decoder.decode(payload));
        
        if (message.type === "status_update") {
          updateUnitPresence(message.channel, message.identity, message.status, message.timestamp);
        } else if (message.type === "emergency") {
          if (message.active) {
            setActiveEmergencies((prev) => ({
              ...prev,
              [message.identity]: {
                channel: message.channel,
                timestamp: message.timestamp,
              },
            }));
            updateUnitPresence(message.channel, message.identity, "emergency", message.timestamp);
          } else {
            setActiveEmergencies((prev) => {
              const updated = { ...prev };
              delete updated[message.identity];
              return updated;
            });
            updateUnitPresence(message.channel, message.identity, "idle", message.timestamp);
          }
        } else if (message.type === "heartbeat") {
          setUnitPresence((prev) => {
            const channelUnits = prev[message.channel] || {};
            const existingUnit = channelUnits[message.identity] || {};
            return {
              ...prev,
              [message.channel]: {
                ...channelUnits,
                [message.identity]: {
                  ...existingUnit,
                  lastSeen: message.timestamp,
                  location: message.location,
                },
              },
            };
          });
        }
      } catch (err) {
        console.error("Error parsing data message:", err);
      }
    });

    return lkRoom;
  }, [dispatcherId, getAudioContext, mutedChannels, updateUnitPresence]);

  const connectAllChannels = async () => {
    try {
      const rooms = {};
      
      for (const channel of ALL_CHANNELS) {
        const token = await getToken(channel);
        const lkRoom = createChannelRoom(channel);
        await lkRoom.connect(LIVEKIT_URL, token);
        
        const existingParticipants = Array.from(lkRoom.remoteParticipants.values());
        existingParticipants.forEach((p) => {
          if (p.identity !== dispatcherId) {
            const isPublishing = Array.from(p.audioTrackPublications.values()).some(
              (pub) => pub.track && !pub.isMuted
            );
            updateUnitPresence(channel, p.identity, isPublishing ? "transmitting" : "idle", Date.now());
          }
        });
        
        rooms[channel] = lkRoom;
      }
      
      setChannelRooms(rooms);
      setConnected(true);
    } catch (err) {
      console.error("Connection error:", err);
      alert("Failed to connect: " + err.message);
    }
  };

  const toggleMute = (channel) => {
    setMutedChannels(prev => ({ ...prev, [channel]: !prev[channel] }));
  };

  const startDispatchPTT = async () => {
    const room = channelRoomsRef.current[selectedTxChannel];
    if (!room) return;

    try {
      setIsTalking(true);
      
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = stream;
      
      const audioTrack = stream.getAudioTracks()[0];
      
      await room.localParticipant.publishTrack(audioTrack, {
        name: "microphone",
        source: Track.Source.Microphone,
      });
      
      audioTrackRef.current = audioTrack;
    } catch (err) {
      console.error("PTT error:", err);
      setIsTalking(false);
    }
  };

  const stopDispatchPTT = async () => {
    const room = channelRoomsRef.current[selectedTxChannel];
    if (!room) return;

    try {
      if (audioTrackRef.current) {
        await room.localParticipant.unpublishTrack(audioTrackRef.current);
        audioTrackRef.current.stop();
        audioTrackRef.current = null;
      }
      
      if (micStreamRef.current) {
        micStreamRef.current.getTracks().forEach(track => track.stop());
        micStreamRef.current = null;
      }
      
      setIsTalking(false);
    } catch (err) {
      console.error("Stop PTT error:", err);
      setIsTalking(false);
    }
  };

  const playRecording = (channel) => {
    const blob = lastRxRecordings[channel];
    if (!blob) return;
    
    setPlayingChannel(channel);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      setPlayingChannel(null);
      URL.revokeObjectURL(url);
    };
    audio.play();
  };

  const disconnect = async () => {
    for (const room of Object.values(channelRoomsRef.current)) {
      await room.disconnect();
    }
    
    Object.values(levelAnimationsRef.current).forEach(id => cancelAnimationFrame(id));
    
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    
    setChannelRooms({});
    setConnected(false);
    setUnitPresence({});
    setActiveEmergencies({});
    setChannelLevels({});
    setActiveTransmissions({});
    setLastRxRecordings({});
  };

  const totalUnits = Object.values(unitPresence).reduce(
    (sum, channelUnits) => sum + Object.keys(channelUnits).length,
    0
  );

  const hasEmergency = Object.keys(activeEmergencies).length > 0;

  return (
    <div style={{
      padding: 16,
      fontFamily: "sans-serif",
      color: "white",
      background: hasEmergency && emergencyFlash ? "#2a0a0a" : "#0a0a0a",
      minHeight: "100vh",
      transition: "background 0.3s",
    }}>
      <div style={{ 
        display: "flex", 
        justifyContent: "space-between", 
        alignItems: "center",
        marginBottom: 16,
        borderBottom: "1px solid #333",
        paddingBottom: 12,
      }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Dispatch Console</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {user?.role === "admin" && (
            <button
              onClick={() => navigate("/admin")}
              style={{
                padding: "6px 12px",
                backgroundColor: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Admin
            </button>
          )}
          <button
            onClick={() => navigate("/")}
            style={{
              padding: "6px 12px",
              backgroundColor: "#4b5563",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Radio
          </button>
          {connected && (
            <button
              onClick={disconnect}
              style={{
                padding: "6px 12px",
                backgroundColor: "#666",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              Disconnect
            </button>
          )}
          <button
            onClick={onLogout}
            style={{
              padding: "6px 12px",
              backgroundColor: "#dc2626",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {!connected ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", marginBottom: 8, fontSize: 14, opacity: 0.7 }}>
              Dispatcher ID
            </label>
            <input
              style={{ 
                padding: "10px 14px", 
                borderRadius: 6, 
                border: "1px solid #444",
                background: "#1a1a1a",
                color: "white",
                width: 200,
                fontSize: 16,
                textAlign: "center",
              }}
              value={dispatcherId}
              onChange={(e) => setDispatcherId(e.target.value)}
              placeholder="DISPATCH"
            />
          </div>
          <button
            onClick={connectAllChannels}
            style={{
              padding: "12px 32px",
              backgroundColor: "#22c55e",
              color: "white",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
              fontSize: 16,
              fontWeight: 600,
            }}
          >
            Connect All Channels
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 300px", gap: 16 }}>
          <div>
            {hasEmergency && (
              <div style={{
                background: emergencyFlash ? "#dc2626" : "#7f1d1d",
                padding: 12,
                borderRadius: 8,
                marginBottom: 16,
                border: "2px solid #dc2626",
              }}>
                <h3 style={{ margin: "0 0 8px 0", fontSize: 14 }}>ACTIVE EMERGENCIES</h3>
                {Object.entries(activeEmergencies).map(([unitId, info]) => (
                  <div
                    key={unitId}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      padding: "6px 8px",
                      background: "rgba(0,0,0,0.3)",
                      borderRadius: 4,
                      marginBottom: 4,
                    }}
                  >
                    <span>
                      <StatusDot status="emergency" />
                      {unitId} on {info.channel}
                    </span>
                    <button
                      onClick={() => acknowledgeEmergency(unitId, info.channel)}
                      style={{
                        padding: "4px 8px",
                        backgroundColor: "#22c55e",
                        color: "white",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 11,
                      }}
                    >
                      ACKNOWLEDGE
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ 
              display: "grid", 
              gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", 
              gap: 12 
            }}>
              {ALL_CHANNELS.map((channel) => (
                <div
                  key={channel}
                  style={{
                    background: activeTransmissions[channel] ? "#1a2a1a" : "#1a1a1a",
                    padding: 12,
                    borderRadius: 8,
                    border: selectedTxChannel === channel ? "2px solid #3b82f6" : "1px solid #333",
                  }}
                >
                  <div style={{ 
                    display: "flex", 
                    justifyContent: "space-between", 
                    alignItems: "center",
                    marginBottom: 8,
                  }}>
                    <span 
                      style={{ fontWeight: "bold", fontSize: 14, cursor: "pointer" }}
                      onClick={() => setSelectedTxChannel(channel)}
                    >
                      {channel}
                    </span>
                    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                      <AudioLevelMeter level={channelLevels[channel] || 0} />
                      <button
                        onClick={() => toggleMute(channel)}
                        style={{
                          padding: "2px 6px",
                          backgroundColor: mutedChannels[channel] ? "#dc2626" : "#333",
                          color: "white",
                          border: "none",
                          borderRadius: 2,
                          cursor: "pointer",
                          fontSize: 10,
                        }}
                      >
                        {mutedChannels[channel] ? "MUTED" : "MUTE"}
                      </button>
                    </div>
                  </div>
                  
                  {activeTransmissions[channel] && (
                    <div style={{ 
                      fontSize: 11, 
                      color: "#eab308",
                      marginBottom: 6,
                    }}>
                      TX: {activeTransmissions[channel].from}
                    </div>
                  )}
                  
                  <div style={{ fontSize: 10, opacity: 0.6 }}>
                    Units: {Object.keys(unitPresence[channel] || {}).length}
                  </div>
                  
                  {lastRxRecordings[channel] && (
                    <button
                      onClick={() => playRecording(channel)}
                      disabled={playingChannel !== null}
                      style={{
                        marginTop: 6,
                        padding: "3px 8px",
                        backgroundColor: playingChannel === channel ? "#666" : "#4b5563",
                        color: "white",
                        border: "none",
                        borderRadius: 2,
                        cursor: playingChannel !== null ? "default" : "pointer",
                        fontSize: 10,
                        width: "100%",
                      }}
                    >
                      {playingChannel === channel ? "Playing..." : "Replay Last"}
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div style={{ marginTop: 16 }}>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: 12, marginRight: 8 }}>TX Channel:</span>
                <select
                  value={selectedTxChannel}
                  onChange={(e) => setSelectedTxChannel(e.target.value)}
                  style={{ padding: 4, borderRadius: 4 }}
                >
                  {ALL_CHANNELS.map(ch => (
                    <option key={ch} value={ch}>{ch}</option>
                  ))}
                </select>
              </div>
              <button
                onMouseDown={startDispatchPTT}
                onMouseUp={stopDispatchPTT}
                onMouseLeave={stopDispatchPTT}
                onTouchStart={startDispatchPTT}
                onTouchEnd={stopDispatchPTT}
                style={{
                  padding: 20,
                  width: "100%",
                  backgroundColor: isTalking ? "#dc2626" : "#b91c1c",
                  color: "white",
                  fontSize: 18,
                  fontWeight: "bold",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  boxShadow: isTalking ? "0 0 20px rgba(220, 38, 38, 0.6)" : "none",
                }}
              >
                {isTalking ? `TRANSMITTING ON ${selectedTxChannel}...` : "DISPATCH PTT"}
              </button>
            </div>
          </div>

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            maxHeight: "calc(100vh - 120px)",
            overflowY: "auto",
          }}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: 14 }}>
              All Units ({totalUnits})
            </h3>
            {Object.entries(unitPresence).map(([channel, units]) => (
              Object.keys(units).length > 0 && (
                <div key={channel} style={{ marginBottom: 12 }}>
                  <div style={{ 
                    fontSize: 11, 
                    opacity: 0.5, 
                    marginBottom: 4,
                    borderBottom: "1px solid #333",
                    paddingBottom: 4,
                  }}>
                    {channel}
                  </div>
                  {Object.entries(units).map(([unitId, info]) => (
                    <div 
                      key={unitId} 
                      style={{ 
                        fontSize: 11, 
                        marginBottom: 2,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        padding: "4px 6px",
                        background: info.status === "emergency" 
                          ? "rgba(220, 38, 38, 0.2)" 
                          : info.status === "transmitting" 
                            ? "rgba(234, 179, 8, 0.1)" 
                            : "transparent",
                        borderRadius: 4,
                      }}
                    >
                      <span style={{ display: "flex", alignItems: "center" }}>
                        <StatusDot status={info.status} />
                        {unitId}
                      </span>
                      {info.lastTransmission && (
                        <span style={{ fontSize: 9, opacity: 0.5 }}>
                          {formatTimestamp(info.lastTransmission)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )
            ))}
            {totalUnits === 0 && (
              <p style={{ opacity: 0.5, margin: 0, fontSize: 11 }}>No units online</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
