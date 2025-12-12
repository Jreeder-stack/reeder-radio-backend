import { useState, useRef, useEffect, useCallback } from "react";
import { Room, RoomEvent, Track, DataPacket_Kind } from "livekit-client";
import { micPTTManager } from "./audio/MicPTTManager";
import { PTT_STATES } from "./constants/pttStates";

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

function AudioLevelMeter({ level }) {
  const barCount = 10;
  const activeCount = Math.round((level / 100) * barCount);
  
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 20 }}>
      {Array.from({ length: barCount }).map((_, i) => (
        <div
          key={i}
          style={{
            width: 4,
            height: 4 + i * 1.5,
            backgroundColor: i < activeCount 
              ? (i >= 7 ? "#dc2626" : i >= 5 ? "#eab308" : "#22c55e")
              : "#333",
            borderRadius: 1,
            transition: "background-color 0.05s",
          }}
        />
      ))}
    </div>
  );
}

function createRxDspChain(audioContext, radioEffectEnabled) {
  const inputGain = audioContext.createGain();
  inputGain.gain.value = 1.0;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.3;

  let highpass = null;
  let lowpass = null;

  if (radioEffectEnabled) {
    highpass = audioContext.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 300;
    highpass.Q.value = 0.5;

    lowpass = audioContext.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = 3400;
    lowpass.Q.value = 0.5;
  }

  const outputGain = audioContext.createGain();
  outputGain.gain.value = 1.0;

  if (radioEffectEnabled && highpass && lowpass) {
    inputGain.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(analyser);
    analyser.connect(outputGain);
  } else {
    inputGain.connect(analyser);
    analyser.connect(outputGain);
  }

  return { inputGain, analyser, outputGain };
}

import { useNavigate } from "react-router-dom";

export default function App({ user, onLogout }) {
  const navigate = useNavigate();
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [zonesData, setZonesData] = useState({});
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [noChannelsAccess, setNoChannelsAccess] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const identity = user?.unit_id || user?.username || "Unknown";
  const [selectedZone, setSelectedZone] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("");
  const [transmitChannel, setTransmitChannel] = useState("");
  const [primaryRoom, setPrimaryRoom] = useState(null);
  const [scanRooms, setScanRooms] = useState({});
  const [unitPresence, setUnitPresence] = useState({});
  const [isTalking, setIsTalking] = useState(false);
  const [pttPressed, setPttPressed] = useState(false); // Visual feedback only - doesn't change button text
  const [scanMode, setScanMode] = useState(false);
  const [scanChannels, setScanChannels] = useState([]);
  const [activeAudio, setActiveAudio] = useState(null);
  const [radioEffect, setRadioEffect] = useState(false);
  const [txLevel, setTxLevel] = useState(0);
  const [rxLevel, setRxLevel] = useState(0);
  const [lastRxBlob, setLastRxBlob] = useState(null);
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const [isEmergency, setIsEmergency] = useState(false);
  const [emergencyLockRemaining, setEmergencyLockRemaining] = useState(0);
  const [activeEmergencies, setActiveEmergencies] = useState({});
  const [emergencyFlash, setEmergencyFlash] = useState(false);

  const scanRoomsRef = useRef({});
  const primaryRoomRef = useRef(null);
  const audioContextRef = useRef(null);
  const txAnalyserRef = useRef(null);
  const rxChainRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordedChunksRef = useRef([]);
  const txAnimationRef = useRef(null);
  const rxAnimationRef = useRef(null);
  const emergencyTimerRef = useRef(null);
  const heartbeatIntervalRef = useRef(null);
  const isEmergencyRef = useRef(false);
  const [userLocation, setUserLocation] = useState(null);
  const [pttState, setPttState] = useState(PTT_STATES.IDLE);


  useEffect(() => {
    scanRoomsRef.current = scanRooms;
  }, [scanRooms]);

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
    primaryRoomRef.current = primaryRoom;
  }, [primaryRoom]);

  useEffect(() => {
    isEmergencyRef.current = isEmergency;
  }, [isEmergency]);

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

  useEffect(() => {
    micPTTManager.onStateChange = (newState) => {
      setPttState(newState);
      if (newState === PTT_STATES.TRANSMITTING) {
        setIsTalking(true);
        if (primaryRoomRef.current) {
          broadcastStatus(primaryRoomRef.current, "transmitting", transmitChannel);
        }
      } else if (newState === PTT_STATES.IDLE) {
        setIsTalking(false);
        if (primaryRoomRef.current) {
          broadcastStatus(primaryRoomRef.current, "idle", transmitChannel);
        }
      }
    };
    
    return () => {
      if (txAnimationRef.current) cancelAnimationFrame(txAnimationRef.current);
      if (rxAnimationRef.current) cancelAnimationFrame(rxAnimationRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      micPTTManager.disconnect();
    };
  }, [broadcastStatus, transmitChannel]);

  useEffect(() => {
    const handleGlobalRelease = (e) => {
      if (isEmergencyRef.current) {
        console.log('[Radio PTT] Global release ignored during emergency');
        return;
      }
      if (!micPTTManager.canStop()) return;
      console.log('[Radio PTT] Global release detected, event:', e.type);
      micPTTManager.stop();
    };

    const captureOptions = { capture: true, passive: false };
    
    document.addEventListener('touchend', handleGlobalRelease, captureOptions);
    document.addEventListener('touchcancel', handleGlobalRelease, captureOptions);
    document.addEventListener('pointerup', handleGlobalRelease, captureOptions);
    document.addEventListener('pointercancel', handleGlobalRelease, captureOptions);
    window.addEventListener('blur', handleGlobalRelease);

    return () => {
      document.removeEventListener('touchend', handleGlobalRelease, captureOptions);
      document.removeEventListener('touchcancel', handleGlobalRelease, captureOptions);
      document.removeEventListener('pointerup', handleGlobalRelease, captureOptions);
      document.removeEventListener('pointercancel', handleGlobalRelease, captureOptions);
      window.removeEventListener('blur', handleGlobalRelease);
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

  const broadcastEmergency = useCallback((room, channel, active) => {
    if (!room || !room.localParticipant) return;
    
    const message = JSON.stringify({
      type: "emergency",
      identity: room.localParticipant.identity,
      channel,
      active,
      timestamp: Date.now(),
    });
    
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    room.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
  }, []);

  const acknowledgeEmergency = useCallback((unitId, channel) => {
    setActiveEmergencies((prev) => {
      const updated = { ...prev };
      delete updated[unitId];
      return updated;
    });
    
    if (primaryRoomRef.current) {
      const message = JSON.stringify({
        type: "emergency_ack",
        targetUnit: unitId,
        channel,
        acknowledgedBy: identity,
        timestamp: Date.now(),
      });
      
      const encoder = new TextEncoder();
      const data = encoder.encode(message);
      primaryRoomRef.current.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
    }
  }, [identity]);

  const broadcastHeartbeat = useCallback((room, channel) => {
    if (!room || !room.localParticipant) return;
    
    const message = JSON.stringify({
      type: "heartbeat",
      identity: room.localParticipant.identity,
      channel,
      location: userLocation,
      timestamp: Date.now(),
    });
    
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    room.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
  }, [userLocation]);

  const startHeartbeat = useCallback((room, channel) => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    
    broadcastHeartbeat(room, channel);
    
    heartbeatIntervalRef.current = setInterval(() => {
      broadcastHeartbeat(room, channel);
    }, 30000);
  }, [broadcastHeartbeat]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
      heartbeatIntervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          setUserLocation({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          });
        },
        (error) => {
          console.log("Geolocation not available:", error.message);
        },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 }
      );
      
      return () => navigator.geolocation.clearWatch(watchId);
    }
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
    const res = await fetch(`${TOKEN_SERVER}?identity=${identity}&room=${room}`, {
      credentials: "include"
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Failed to get token");
    }
    return data.token;
  };

  const startRxLevelMonitor = useCallback((analyser) => {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const updateLevel = () => {
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      setRxLevel(Math.min(100, avg * 1.5));
      rxAnimationRef.current = requestAnimationFrame(updateLevel);
    };
    
    updateLevel();
  }, []);

  const stopRxLevelMonitor = useCallback(() => {
    if (rxAnimationRef.current) {
      cancelAnimationFrame(rxAnimationRef.current);
      rxAnimationRef.current = null;
    }
    setRxLevel(0);
  }, []);

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
        // Attach track to get audio element - LiveKit handles playback
        const audioElem = track.attach();
        audioElem.dataset.channel = channelName;
        audioElem.dataset.participant = participant.identity;
        
        // Ensure it can autoplay on iOS
        audioElem.playsInline = true;
        audioElem.autoplay = true;
        
        // Try to play (may need user gesture on some browsers)
        audioElem.play().catch(() => {
          console.log('[Radio PTT] Audio autoplay blocked, will play on user gesture');
        });
        
        // Simple approach: just let the audio element play directly
        // Skip Web Audio processing for maximum compatibility
        console.log('[Radio PTT] Receiving audio from', participant.identity);
        
        setActiveAudio({ channel: channelName, from: participant.identity });
        updateUnitPresence(channelName, participant.identity, "transmitting", Date.now());
      }
    });

    lkRoom.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      // Detach and clean up audio elements
      track.detach().forEach((el) => el.remove());
      setActiveAudio(null);
      updateUnitPresence(channelName, participant.identity, "idle", Date.now());
      console.log('[Radio PTT] Transmission ended from', participant.identity);
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
        } else if (message.type === "emergency_ack") {
          if (message.targetUnit === identity) {
            setIsEmergency(false);
            if (emergencyTimerRef.current) {
              clearInterval(emergencyTimerRef.current);
              emergencyTimerRef.current = null;
            }
            setEmergencyLockRemaining(0);
          }
          setActiveEmergencies((prev) => {
            const updated = { ...prev };
            delete updated[message.targetUnit];
            return updated;
          });
          updateUnitPresence(message.channel, message.targetUnit, "idle", Date.now());
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
  }, [updateUnitPresence, getAudioContext, radioEffect, startRxLevelMonitor, stopRxLevelMonitor, identity]);

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

  const connectToChannel = async (channel = selectedChannel) => {
    try {
      setConnecting(true);
      setConnectionError(null);

      const token = await getToken(channel);
      if (!token) {
        setConnectionError("Invalid token received from backend.");
        setConnecting(false);
        return;
      }

      const lkRoom = createRoom(channel);
      await lkRoom.connect(LIVEKIT_URL, token);

      initializePresence(lkRoom, channel);

      setPrimaryRoom(lkRoom);
      setSelectedChannel(channel);
      setTransmitChannel(channel);
      setConnected(true);
      setConnecting(false);

      broadcastStatus(lkRoom, "idle", channel);
      startHeartbeat(lkRoom, channel);

    } catch (err) {
      console.error("Connection error:", err);
      setConnectionError(err.message || "Failed to connect to channel");
      setConnecting(false);
    }
  };

  useEffect(() => {
    const loadChannels = async () => {
      try {
        const res = await fetch("/api/channels", { credentials: "include" });
        if (res.ok) {
          const data = await res.json();
          if (!data.channels || data.channels.length === 0) {
            setNoChannelsAccess(true);
            setZonesData({});
            setSelectedChannel("");
            setSelectedZone("");
            setChannelsLoaded(true);
            return;
          }
          const grouped = {};
          data.channels.forEach((ch) => {
            if (!grouped[ch.zone]) {
              grouped[ch.zone] = [];
            }
            grouped[ch.zone].push(ch.name);
          });
          if (Object.keys(grouped).length > 0) {
            setZonesData(grouped);
            const firstZone = Object.keys(grouped)[0];
            const firstChannel = grouped[firstZone][0];
            setSelectedZone(firstZone);
            setSelectedChannel(firstChannel);
            setNoChannelsAccess(false);
            setChannelsLoaded(true);
          } else {
            setNoChannelsAccess(true);
            setZonesData({});
            setSelectedChannel("");
            setSelectedZone("");
            setChannelsLoaded(true);
          }
        }
      } catch (err) {
        console.error("Failed to load channels:", err);
        setConnectionError("Failed to load channels");
        setChannelsLoaded(true);
      }
    };
    loadChannels();
  }, []);

  useEffect(() => {
    const zoneKeys = Object.keys(zonesData);
    if (!connected && !connecting && channelsLoaded && identity && !noChannelsAccess && zoneKeys.length > 0) {
      const firstZone = zoneKeys[0];
      const firstChannel = zonesData[firstZone]?.[0];
      if (firstChannel) {
        connectToChannel(firstChannel);
      }
    }
  }, [channelsLoaded, noChannelsAccess, zonesData]);

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

  const startPTT = useCallback(async () => {
    if (!micPTTManager.canStart()) {
      console.log('[Radio PTT] Cannot start, manager not ready');
      return false;
    }
    
    if (!primaryRoomRef.current) {
      console.log('[Radio PTT] No room connected');
      return false;
    }

    micPTTManager.setRoom(primaryRoomRef.current);
    return await micPTTManager.start();
  }, []);

  const stopPTT = useCallback(async () => {
    if (!micPTTManager.canStop()) {
      return;
    }
    await micPTTManager.stop();
  }, []);

  const handlePTTDown = useCallback(async (e) => {
    if (e && e.type === 'keydown' && e.repeat) return;
    
    console.log('[Radio PTT] === PTT DOWN ===, state:', pttState);
    
    if (!micPTTManager.canStart()) {
      console.log('[Radio PTT] Ignoring PTT down, not idle');
      return;
    }
    
    await startPTT();
  }, [pttState, startPTT]);

  const handlePTTUp = useCallback(async () => {
    console.log('[Radio PTT] === PTT UP ===, state:', pttState);
    
    setPttPressed(false);
    
    if (pttState === PTT_STATES.IDLE) {
      return;
    }
    
    await stopPTT();
  }, [pttState, stopPTT]);

  const handleTouchStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.isTrusted) return;
    if (isEmergency) return;
    
    setPttPressed(true);
    handlePTTDown(e);
  }, [isEmergency, handlePTTDown]);

  const handleTouchEnd = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    handlePTTUp();
  }, [handlePTTUp]);

  const handleMouseDown = useCallback((e) => {
    if (!e.isTrusted) return;
    if (isEmergency) return;
    
    setPttPressed(true);
    handlePTTDown(e);
  }, [isEmergency, handlePTTDown]);

  const playLastRx = () => {
    if (!lastRxBlob) return;
    
    setIsPlayingRecording(true);
    const url = URL.createObjectURL(lastRxBlob);
    const audio = new Audio(url);
    audio.onended = () => {
      setIsPlayingRecording(false);
      URL.revokeObjectURL(url);
    };
    audio.play();
  };

  const triggerEmergency = async () => {
    if (!primaryRoomRef.current || isEmergency) return;
    
    setIsEmergency(true);
    setEmergencyLockRemaining(10);
    
    broadcastEmergency(primaryRoomRef.current, transmitChannel, true);
    broadcastStatus(primaryRoomRef.current, "emergency", transmitChannel);
    updateUnitPresence(transmitChannel, identity, "emergency", Date.now());
    
    await startPTT();
    
    let remaining = 10;
    emergencyTimerRef.current = setInterval(() => {
      remaining -= 1;
      setEmergencyLockRemaining(remaining);
      
      if (remaining <= 0) {
        clearInterval(emergencyTimerRef.current);
        emergencyTimerRef.current = null;
        stopPTT();
        setIsEmergency(false);
        setEmergencyLockRemaining(0);
      }
    }, 1000);
  };

  const cancelEmergency = async () => {
    if (!primaryRoomRef.current) return;
    
    if (emergencyTimerRef.current) {
      clearInterval(emergencyTimerRef.current);
      emergencyTimerRef.current = null;
    }
    
    await stopPTT();
    setIsEmergency(false);
    setEmergencyLockRemaining(0);
    
    broadcastEmergency(primaryRoomRef.current, transmitChannel, false);
    broadcastStatus(primaryRoomRef.current, "idle", transmitChannel);
    updateUnitPresence(transmitChannel, identity, "idle", Date.now());
  };

  const disconnect = async () => {
    stopHeartbeat();
    micPTTManager.disconnect();
    
    if (primaryRoomRef.current) {
      await primaryRoomRef.current.disconnect();
    }

    for (const room of Object.values(scanRoomsRef.current)) {
      await room.disconnect();
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    setPrimaryRoom(null);
    setScanRooms({});
    setScanChannels([]);
    setConnected(false);
    setUnitPresence({});
    setScanMode(false);
    setLastRxBlob(null);
  };

  const currentZoneChannels = zonesData[selectedZone] || [];
  
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Reeder PTT Radio</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {user?.role === "admin" && (
            <button
              onClick={() => navigate("/admin")}
              style={{
                padding: "8px 16px",
                backgroundColor: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Admin
            </button>
          )}
          {(user?.is_dispatcher || user?.role === "admin") && (
            <button
              onClick={() => navigate("/dispatcher")}
              style={{
                padding: "8px 16px",
                backgroundColor: "#6366f1",
                color: "white",
                border: "none",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 14,
              }}
            >
              Dispatcher
            </button>
          )}
          <button
            onClick={onLogout}
            style={{
              padding: "8px 16px",
              backgroundColor: "#dc2626",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {noChannelsAccess ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 18, marginBottom: 16, color: "#dc2626" }}>No Channel Access</div>
          <div style={{ fontSize: 14, color: "#888", marginBottom: 16 }}>
            You do not have access to any radio channels.
          </div>
          <div style={{ fontSize: 14, color: "#888" }}>
            Please contact your administrator to request channel access.
          </div>
        </div>
      ) : connectionError ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 18, marginBottom: 16, color: "#dc2626" }}>Connection Error</div>
          <div style={{ fontSize: 14, color: "#888", marginBottom: 16 }}>{connectionError}</div>
          <button
            onClick={() => {
              setConnectionError(null);
              const firstZone = Object.keys(zonesData)[0];
              if (firstZone && zonesData[firstZone]?.[0]) {
                connectToChannel(zonesData[firstZone][0]);
              }
            }}
            style={{
              padding: "10px 20px",
              backgroundColor: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Retry Connection
          </button>
        </div>
      ) : !connected ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 18, marginBottom: 16 }}>Connecting to radio network...</div>
          <div style={{ fontSize: 14, color: "#888" }}>Unit: {identity}</div>
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

          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              {Object.keys(zonesData).map((zone) => (
                <button
                  key={zone}
                  onClick={() => {
                    setSelectedZone(zone);
                    const firstChannel = zonesData[zone][0];
                    switchChannel(firstChannel);
                  }}
                  style={{
                    padding: "6px 10px",
                    backgroundColor: zone === selectedZone ? "#6366f1" : "#222",
                    color: "white",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {zone.replace("Zone ", "Z").split(" - ")[0]}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
          </div>

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            marginBottom: 16
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 14 }}>Audio Settings</h3>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12 }}>Radio Effect (narrowband)</span>
              <button
                onClick={() => setRadioEffect(!radioEffect)}
                style={{
                  padding: "4px 12px",
                  backgroundColor: radioEffect ? "#3b82f6" : "#444",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                {radioEffect ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <div style={{ 
            background: "#1a1a1a", 
            padding: 12, 
            borderRadius: 8,
            marginBottom: 16
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, width: 24 }}>TX</span>
                <AudioLevelMeter level={txLevel} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 12, width: 24 }}>RX</span>
                <AudioLevelMeter level={rxLevel} />
              </div>
            </div>
            {lastRxBlob && (
              <button
                onClick={playLastRx}
                disabled={isPlayingRecording}
                style={{
                  width: "100%",
                  padding: "8px",
                  backgroundColor: isPlayingRecording ? "#666" : "#4b5563",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: isPlayingRecording ? "default" : "pointer",
                  fontSize: 12,
                }}
              >
                {isPlayingRecording ? "Playing..." : "Replay Last RX"}
              </button>
            )}
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
              <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto" }}>
                <p style={{ fontSize: 12, opacity: 0.6, margin: "0 0 8px 0" }}>
                  Select channels to monitor (TX on {transmitChannel}):
                </p>
                {Object.entries(zonesData).map(([zoneName, zoneChannels]) => (
                  <div key={zoneName} style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>{zoneName}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {zoneChannels.filter(ch => ch !== selectedChannel).map((ch) => (
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
                ))}
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

          {Object.keys(activeEmergencies).length > 0 && (
            <div style={{
              background: emergencyFlash ? "#dc2626" : "#7f1d1d",
              padding: 12,
              borderRadius: 8,
              marginBottom: 16,
              border: "2px solid #dc2626",
            }}>
              <h3 style={{ margin: "0 0 8px 0", fontSize: 14, textAlign: "center" }}>
                ACTIVE EMERGENCIES
              </h3>
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
                    ACK
                  </button>
                </div>
              ))}
            </div>
          )}

          {isEmergency && (
            <div style={{
              background: emergencyFlash ? "#dc2626" : "#7f1d1d",
              padding: 16,
              borderRadius: 8,
              marginBottom: 16,
              textAlign: "center",
              border: "2px solid #dc2626",
            }}>
              <div style={{ fontSize: 18, fontWeight: "bold", marginBottom: 8 }}>
                EMERGENCY ACTIVE
              </div>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                TX Lock: {emergencyLockRemaining}s remaining
              </div>
              <button
                onClick={cancelEmergency}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#666",
                  color: "white",
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                Cancel Emergency
              </button>
            </div>
          )}

          <button
            onClick={triggerEmergency}
            disabled={isEmergency}
            style={{
              padding: 16,
              width: "100%",
              backgroundColor: isEmergency ? "#7f1d1d" : "#f97316",
              color: "white",
              fontSize: 16,
              fontWeight: "bold",
              border: "2px solid #f97316",
              borderRadius: 8,
              cursor: isEmergency ? "default" : "pointer",
              marginBottom: 12,
              opacity: isEmergency ? 0.5 : 1,
            }}
          >
            EMERGENCY
          </button>

          <button
            onMouseDown={handleMouseDown}
            onMouseUp={handlePTTUp}
            onMouseLeave={handlePTTUp}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchEnd}
            disabled={isEmergency}
            style={{
              padding: 30,
              width: "100%",
              // pttPressed gives instant visual feedback, isTalking shows actual TX state
              backgroundColor: (pttPressed || isTalking) ? "#dc2626" : "#b91c1c",
              color: "white",
              fontSize: 22,
              fontWeight: "bold",
              border: "none",
              borderRadius: 12,
              cursor: isEmergency ? "default" : "pointer",
              boxShadow: (pttPressed || isTalking) ? "0 0 30px rgba(220, 38, 38, 0.6)" : "none",
              transition: "background-color 0.05s, box-shadow 0.05s",
              opacity: isEmergency ? 0.5 : 1,
              touchAction: "manipulation",
              userSelect: "none",
              WebkitUserSelect: "none",
              WebkitTouchCallout: "none",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            {isTalking ? "TRANSMITTING..." : "PUSH TO TALK"}
          </button>
        </div>
      )}
    </div>
  );
}
