import { useState, useRef, useEffect, useCallback } from "react";
import { PTT_STATES } from "./constants/pttStates";
import { updateUnitStatus } from "./utils/api.js";
import { useAudioConnection } from "./context/AudioConnectionContext.jsx";
import { useSignalingContext } from "./context/SignalingContext.jsx";
import { unlockAudio } from "./audio/iosAudioUnlock";
import { preloadPermitBuffer } from "./audio/talkPermitTone.js";
import { setupAppLifecycle } from "./lib/capacitor";
import { signalingManager } from "./signaling/SignalingManager";
import { useMobileRadioContext } from "./context/MobileRadioContext.jsx";

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
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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

import { useNavigate } from "react-router-dom";

const THEMES = {
  dark: {
    bg: "#111",
    bgSecondary: "#1a1a1a",
    bgTertiary: "#222",
    text: "#fff",
    textSecondary: "#aaa",
    textMuted: "#666",
    border: "#333",
    buttonBg: "#333",
    buttonBgActive: "#3b82f6",
  },
  light: {
    bg: "#f5f5f5",
    bgSecondary: "#fff",
    bgTertiary: "#e5e5e5",
    text: "#111",
    textSecondary: "#444",
    textMuted: "#888",
    border: "#ccc",
    buttonBg: "#ddd",
    buttonBgActive: "#3b82f6",
  }
};

export default function App({ user, onLogout }) {
  const navigate = useNavigate();
  
  const { 
    audioTransportManager, 
    connectionStatus, 
    connectionHealth, 
    channels: contextChannels,
    switchChannel: contextSwitchChannel,
    ensureConnected,
    recordActivity,
    toggleScanMode: contextToggleScanMode,
  } = useAudioConnection();

  const {
    joinChannel: signalingJoinChannel,
    leaveChannel: signalingLeaveChannel,
    signalPttStart,
    signalPttEnd,
  } = useSignalingContext();
  
  const { setIsEmergency: setContextIsEmergency } = useMobileRadioContext();
  
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const theme = darkMode ? THEMES.dark : THEMES.light;
  
  const connected = connectionStatus === 'connected';
  const connecting = connectionStatus === 'connecting';
  const [zonesData, setZonesData] = useState({});
  const [channelDisplayNames, setChannelDisplayNames] = useState({});
  const [channelsLoaded, setChannelsLoaded] = useState(false);
  const [noChannelsAccess, setNoChannelsAccess] = useState(false);
  const [connectionError, setConnectionError] = useState(null);
  const identity = (user?.unit_id && user.unit_id.trim()) || user?.username || "Unknown";
  const [selectedZone, setSelectedZone] = useState("");
  const [selectedChannel, setSelectedChannel] = useState("");
  const [transmitChannel, setTransmitChannel] = useState("");
  const getDisplayName = useCallback((roomKey) => channelDisplayNames[roomKey] || roomKey, [channelDisplayNames]);
  const [unitPresence, setUnitPresence] = useState({});
  const [isTalking, setIsTalking] = useState(false);
  const [pttPressed, setPttPressed] = useState(false); // Visual feedback only - doesn't change button text
  const [scanMode, setScanMode] = useState(false);
  const [scanChannels, setScanChannels] = useState([]);
  const [activeAudio, setActiveAudio] = useState(null);
  const [txLevel, setTxLevel] = useState(0);
  const [rxLevel, setRxLevel] = useState(0);
  const [lastRxBlob, setLastRxBlob] = useState(null);
  const [isPlayingRecording, setIsPlayingRecording] = useState(false);
  const [isEmergency, setIsEmergency] = useState(false);
  const [emergencyLockRemaining, setEmergencyLockRemaining] = useState(0);
  const [activeEmergencies, setActiveEmergencies] = useState({});
  const [emergencyFlash, setEmergencyFlash] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showUnits, setShowUnits] = useState(false);

  const toggleDarkMode = () => {
    setDarkMode(prev => {
      const next = !prev;
      localStorage.setItem('darkMode', JSON.stringify(next));
      return next;
    });
  };

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
  const rxAudioElementsRef = useRef(new Set());
  const transmitChannelRef = useRef("");
  const aiPlaybackActiveRef = useRef(false);
  const emergencyPausedForAIRef = useRef(false);
  const emergencyRemainingWhenPausedRef = useRef(0);
  const [emergencyResponseWindow, setEmergencyResponseWindow] = useState(false);
  const emergencyResponseTimeoutRef = useRef(null);
  const emergencyResponseWindowRef = useRef(false);
  const [userLocation, setUserLocation] = useState(null);
  const [pttState, setPttState] = useState(PTT_STATES.IDLE);

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

  useEffect(() => {
    transmitChannelRef.current = transmitChannel;
  }, [transmitChannel]);

  useEffect(() => {
    const cleanup = setupAppLifecycle(
      () => {
        console.log('[App] App resumed — verifying connections');
        signalingManager.verifyConnection().then(ok => {
          if (ok) {
            console.log('[App] Signaling connection verified');
          } else {
            console.warn('[App] Signaling connection could not be restored');
          }
        });
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          audioContextRef.current.resume().then(() => console.log('[App] AudioContext resumed'));
        }
      },
      () => {
        console.log('[App] App paused — keeping connections alive');
      }
    );
    return cleanup;
  }, []);

  useEffect(() => {
    preloadPermitBuffer();
  }, []);

  useEffect(() => {
    if (!audioTransportManager) return;
    console.log('[Radio] Disabling AudioTransportManager auto-playback - radio handles its own audio');
    audioTransportManager.setAutoPlayback(false);
    
    const listenerRemovers = [];
    
    // Use new listener pattern - these get added alongside context listeners
    listenerRemovers.push(
      audioTransportManager.addTrackSubscribedListener((channelName, track, participant) => {
        console.log(`[Radio] Track received: kind=${track.kind}, from ${participant.identity} on ${channelName}`);
        if (track.kind !== 'audio') return;
        
        console.log(`[Radio] Audio track subscribed from ${participant.identity} on ${channelName}`);
        
        const audioElem = track.attach();
        audioElem.dataset.channel = channelName;
        audioElem.dataset.participant = participant.identity;
        audioElem.playsInline = true;
        audioElem.autoplay = true;
        audioElem.style.display = 'none';
        
        document.body.appendChild(audioElem);
        rxAudioElementsRef.current.add(audioElem);
        
        const currentState = audioTransportManager.getState();
        if (currentState === PTT_STATES.TRANSMITTING || currentState === PTT_STATES.ARMING) {
          audioElem.muted = true;
          console.log('[Radio] Muting incoming audio - we are transmitting');
        } else {
          audioElem.muted = false;
          audioElem.volume = 1.0;
        }
        
        audioElem.play().catch((e) => {
          console.log('[Radio] Audio autoplay blocked:', e.message);
        });
        
        setActiveAudio({ channel: channelName, from: participant.identity });
        updateUnitPresence(channelName, participant.identity, "transmitting", Date.now());
      })
    );
    
    listenerRemovers.push(
      audioTransportManager.addTrackUnsubscribedListener((channelName, track, participant) => {
        console.log(`[Radio] Audio track unsubscribed from ${participant.identity} on ${channelName}`);
        const detachedElements = track.detach();
        detachedElements.forEach((el) => {
          rxAudioElementsRef.current.delete(el);
          el.remove();
        });
        setActiveAudio(null);
        updateUnitPresence(channelName, participant.identity, "idle", Date.now());
      })
    );
    
    listenerRemovers.push(
      audioTransportManager.addParticipantConnectedListener((channelName, participant) => {
        updateUnitPresence(channelName, participant.identity, "idle", Date.now());
      })
    );
    
    listenerRemovers.push(
      audioTransportManager.addParticipantDisconnectedListener((channelName, participant) => {
        setUnitPresence((prev) => {
          const channelUnits = { ...(prev[channelName] || {}) };
          delete channelUnits[participant.identity];
          return { ...prev, [channelName]: channelUnits };
        });
      })
    );
    
    listenerRemovers.push(
      audioTransportManager.addDataReceivedListener((channelName, message, participant) => {
        if (message.type === "status_update") {
          updateUnitPresence(message.channel, message.identity, message.status, message.timestamp);
        } else if (message.type === "emergency") {
          if (message.active) {
            setActiveEmergencies((prev) => ({
              ...prev,
              [message.identity]: { channel: message.channel, timestamp: message.timestamp },
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
            console.log('[Radio] Emergency ACK received - clearing emergency state');
            setIsEmergency(false);
            isEmergencyRef.current = false;
            setContextIsEmergency(false);
            if (emergencyTimerRef.current) {
              clearInterval(emergencyTimerRef.current);
              emergencyTimerRef.current = null;
            }
            if (emergencyResponseTimeoutRef.current) {
              clearTimeout(emergencyResponseTimeoutRef.current);
              emergencyResponseTimeoutRef.current = null;
            }
            setEmergencyLockRemaining(0);
            setEmergencyResponseWindow(false);
            emergencyPausedForAIRef.current = false;
            
            rxAudioElementsRef.current.forEach(el => {
              el.muted = false;
            });
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
        } else if (message.type === "ai-playback-start") {
          console.log('[Radio] AI playback starting - pausing emergency if active');
          aiPlaybackActiveRef.current = true;
          
          // Clear any existing response timeout
          if (emergencyResponseTimeoutRef.current) {
            clearTimeout(emergencyResponseTimeoutRef.current);
            emergencyResponseTimeoutRef.current = null;
          }
          setEmergencyResponseWindow(false);
          
          // If in emergency mode, pause to let AI speak
          if (isEmergencyRef.current) {
            console.log('[Radio] Pausing emergency PTT for AI playback');
            emergencyPausedForAIRef.current = true;
            
            // Stop the emergency timer
            if (emergencyTimerRef.current) {
              clearInterval(emergencyTimerRef.current);
              emergencyTimerRef.current = null;
            }
            
            // Stop PTT to let AI be heard
            audioTransportManager.forceRelease();
            
            // Unmute receive audio
            rxAudioElementsRef.current.forEach(el => {
              el.muted = false;
            });
          }
        } else if (message.type === "ai-playback-end") {
          console.log('[Radio] AI playback ended');
          aiPlaybackActiveRef.current = false;
          
          // If we paused emergency for AI, open a response window
          if (emergencyPausedForAIRef.current && isEmergencyRef.current) {
            console.log('[Radio] Opening 5-second response window after AI playback');
            emergencyPausedForAIRef.current = false;
            
            // Open response window - allows manual PTT during emergency
            setEmergencyResponseWindow(true);
            
            // Close response window after 5 seconds and wait for next AI check
            // (Emergency remains active - AI will do another status check if no response)
            emergencyResponseTimeoutRef.current = setTimeout(() => {
              console.log('[Radio] Response window closed, emergency remains active');
              setEmergencyResponseWindow(false);
              emergencyResponseTimeoutRef.current = null;
              // Don't restart hot mic - just wait for next AI status check
              // The AI escalation controller will repeat or escalate as needed
            }, 5000);
          }
        }
      })
    );
    
    return () => {
      console.log('[Radio] Cleanup - re-enabling AudioTransportManager auto-playback and removing listeners');
      if (audioTransportManager) {
        audioTransportManager.setAutoPlayback(true);
      }
      // Remove all our listeners
      listenerRemovers.forEach(remove => remove());
    };
  }, [audioTransportManager, updateUnitPresence, identity]);

  const getCurrentRoom = useCallback(() => {
    if (!audioTransportManager || !transmitChannelRef.current) return null;
    return audioTransportManager.getRoom(transmitChannelRef.current);
  }, [audioTransportManager]);

  const broadcastStatus = useCallback((status, channel) => {
    if (!audioTransportManager?.isConnected(channel)) return;
    
    audioTransportManager.sendData(channel, {
      type: "status_update",
      identity,
      status,
      channel,
      timestamp: Date.now(),
    });
  }, [audioTransportManager, identity]);

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
    isEmergencyRef.current = isEmergency;
  }, [isEmergency]);

  useEffect(() => {
    emergencyResponseWindowRef.current = emergencyResponseWindow;
  }, [emergencyResponseWindow]);

  useEffect(() => {
    audioTransportManager.onStateChange = (newState) => {
      setPttState(newState);
      const txChannel = transmitChannelRef.current;
      
      if (newState === PTT_STATES.ARMING) {
        console.log('[Radio PTT] ARMING - muting all RX audio');
        rxAudioElementsRef.current.forEach(el => {
          el.muted = true;
        });
      } else if (newState === PTT_STATES.TRANSMITTING) {
        setIsTalking(true);
        rxAudioElementsRef.current.forEach(el => {
          el.muted = true;
        });
        if (txChannel) {
          broadcastStatus("transmitting", txChannel);
          updateUnitStatus(identity, txChannel, 'transmitting', userLocation, isEmergencyRef.current).catch(err => {
            console.log('[Radio] Failed to update transmitting status:', err.message);
          });
        }
      } else if (newState === PTT_STATES.IDLE) {
        setIsTalking(false);
        rxAudioElementsRef.current.forEach(el => {
          el.muted = false;
        });
        if (txChannel) {
          broadcastStatus("idle", txChannel);
          updateUnitStatus(identity, txChannel, 'idle', userLocation, isEmergencyRef.current).catch(err => {
            console.log('[Radio] Failed to update idle status:', err.message);
          });
        }
      }
    };
    
    return () => {
      if (txAnimationRef.current) cancelAnimationFrame(txAnimationRef.current);
      if (rxAnimationRef.current) cancelAnimationFrame(rxAnimationRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
      audioTransportManager.disconnect();
    };
  }, [broadcastStatus, identity, userLocation]);

  useEffect(() => {
    const handleGlobalRelease = (e) => {
      if (isEmergencyRef.current) {
        console.log('[Radio PTT] Global release ignored during emergency');
        return;
      }
      if (!audioTransportManager.canStop()) return;
      console.log('[Radio PTT] Global release detected, event:', e.type);
      audioTransportManager.stop();
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

  const broadcastEmergency = useCallback((channel, active) => {
    if (!audioTransportManager?.isConnected(channel)) return;
    
    audioTransportManager.sendData(channel, {
      type: "emergency",
      identity,
      channel,
      active,
      timestamp: Date.now(),
    });
  }, [audioTransportManager, identity]);

  const acknowledgeEmergency = useCallback((unitId, channel) => {
    setActiveEmergencies((prev) => {
      const updated = { ...prev };
      delete updated[unitId];
      return updated;
    });
    
    const targetChannel = channel || transmitChannelRef.current;
    if (targetChannel) {
      audioTransportManager?.sendData(targetChannel, {
        type: "emergency_ack",
        targetUnit: unitId,
        channel,
        acknowledgedBy: identity,
        timestamp: Date.now(),
      });
    }
  }, [identity, audioTransportManager]);

  const broadcastHeartbeat = useCallback((channel) => {
    if (!audioTransportManager?.isConnected(channel)) {
      return;
    }
    
    audioTransportManager.sendData(channel, {
      type: "heartbeat",
      identity,
      channel,
      location: userLocation,
      timestamp: Date.now(),
    });
  }, [userLocation, audioTransportManager, identity]);

  const startHeartbeat = useCallback((channel) => {
    if (heartbeatIntervalRef.current) {
      clearInterval(heartbeatIntervalRef.current);
    }
    
    broadcastHeartbeat(channel);
    
    heartbeatIntervalRef.current = setInterval(() => {
      broadcastHeartbeat(channel);
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

  useEffect(() => {
    if (!contextChannels || contextChannels.length === 0) {
      setNoChannelsAccess(true);
      setZonesData({});
      setSelectedChannel("");
      setSelectedZone("");
      setChannelsLoaded(true);
      return;
    }
    
    const grouped = {};
    const displayNames = {};
    contextChannels.forEach((ch) => {
      const zoneName = ch.zone || 'Default';
      const roomKey = ch.room_key || (zoneName + '__' + ch.name);
      displayNames[roomKey] = ch.name;
      if (!grouped[zoneName]) {
        grouped[zoneName] = [];
      }
      grouped[zoneName].push(roomKey);
    });
    setChannelDisplayNames(displayNames);
    
    if (Object.keys(grouped).length > 0) {
      setZonesData(grouped);
      const firstZone = Object.keys(grouped)[0];
      const firstChannel = grouped[firstZone][0];
      setSelectedZone(firstZone);
      if (!selectedChannel) {
        setSelectedChannel(firstChannel);
        setTransmitChannel(firstChannel);
      }
      setNoChannelsAccess(false);
      setChannelsLoaded(true);
    } else {
      setNoChannelsAccess(true);
      setZonesData({});
      setSelectedChannel("");
      setSelectedZone("");
      setChannelsLoaded(true);
    }
  }, [contextChannels]);

  const prevSignalingChannelRef = useRef(null);

  useEffect(() => {
    if (connected && transmitChannel && audioTransportManager) {
      if (prevSignalingChannelRef.current && prevSignalingChannelRef.current !== transmitChannel) {
        signalingLeaveChannel(prevSignalingChannelRef.current);
      }
      signalingJoinChannel(transmitChannel);
      prevSignalingChannelRef.current = transmitChannel;

      audioTransportManager.setPrimaryTxChannel(transmitChannel);
      broadcastStatus("idle", transmitChannel);
      startHeartbeat(transmitChannel);
      
      const room = audioTransportManager.getRoom(transmitChannel);
      if (room) {
        initializePresence(room, transmitChannel);
      }
      
      updateUnitStatus(identity, transmitChannel, 'idle', userLocation, false).catch(err => {
        console.log('[Radio] Failed to register unit:', err.message);
      });
    }
  }, [connected, transmitChannel, audioTransportManager, broadcastStatus, startHeartbeat, identity, userLocation, initializePresence, signalingJoinChannel, signalingLeaveChannel]);

  const switchChannel = useCallback(async (newChannel) => {
    if (!connected || newChannel === selectedChannel) return;
    
    if (selectedChannel) {
      signalingLeaveChannel(selectedChannel);
    }
    
    prevSignalingChannelRef.current = newChannel;
    setSelectedChannel(newChannel);
    setTransmitChannel(newChannel);
    
    signalingJoinChannel(newChannel);
    
    await contextSwitchChannel(newChannel, identity);
    
    if (audioTransportManager) {
      audioTransportManager.setPrimaryTxChannel(newChannel);
      broadcastStatus("idle", newChannel);
      
      const room = audioTransportManager.getRoom(newChannel);
      if (room) {
        initializePresence(room, newChannel);
      }
    }
  }, [connected, selectedChannel, audioTransportManager, broadcastStatus, initializePresence, contextSwitchChannel, identity, signalingJoinChannel, signalingLeaveChannel]);

  const toggleScanChannel = useCallback(async (channel) => {
    if (channel === selectedChannel) return;

    let newScanChannels;
    if (scanChannels.includes(channel)) {
      newScanChannels = scanChannels.filter((c) => c !== channel);
      setScanChannels(newScanChannels);
      setUnitPresence((prev) => {
        const updated = { ...prev };
        delete updated[channel];
        return updated;
      });
    } else {
      newScanChannels = [...scanChannels, channel];
      setScanChannels(newScanChannels);
      
      if (audioTransportManager) {
        const room = audioTransportManager.getRoom(channel);
        if (room) {
          initializePresence(room, channel);
        }
      }
    }
    
    if (scanMode) {
      await contextToggleScanMode(true, newScanChannels, identity);
    }
  }, [selectedChannel, scanChannels, scanMode, audioTransportManager, initializePresence, contextToggleScanMode, identity]);

  const startPTT = useCallback(async () => {
    if (!audioTransportManager) {
      console.log('[Radio PTT] No audioTransportManager');
      return false;
    }
    
    if (!audioTransportManager.canStartTransmit()) {
      console.log('[Radio PTT] Cannot start, manager not ready or channel not healthy');
      return false;
    }
    
    return await audioTransportManager.startTransmit();
  }, [audioTransportManager]);

  const stopPTT = useCallback(async () => {
    if (!audioTransportManager) return;
    await audioTransportManager.stopTransmit();
  }, [audioTransportManager]);

  const handlePTTDown = useCallback(async (e) => {
    if (e && e.type === 'keydown' && e.repeat) return;
    
    // Block PTT during emergency UNLESS in response window (using refs for proper closure)
    if (isEmergencyRef.current && !emergencyResponseWindowRef.current) {
      console.log('[Radio PTT] Blocked - emergency active, not in response window');
      return;
    }
    
    unlockAudio();
    recordActivity();
    
    console.log('[Radio PTT] === PTT DOWN ===, state:', pttState);
    
    if (!audioTransportManager.canStart()) {
      console.log('[Radio PTT] Ignoring PTT down, not idle');
      return;
    }
    
    const isConnected = await ensureConnected(transmitChannel);
    if (!isConnected) {
      console.log('[Radio PTT] Cannot transmit - not connected');
      return;
    }
    
    try {
      await signalPttStart(transmitChannel);
    } catch (grantErr) {
      console.warn('[Radio PTT] Floor denied:', grantErr.message);
      return;
    }
    
    const started = await startPTT();
    if (!started) {
      console.warn('[Radio PTT] startPTT failed, releasing floor');
      signalPttEnd(transmitChannel);
    }
  }, [pttState, startPTT, recordActivity, ensureConnected, transmitChannel, signalPttStart, signalPttEnd]);

  const handlePTTUp = useCallback(async () => {
    console.log('[Radio PTT] === PTT UP ===, state:', pttState);
    
    setPttPressed(false);
    
    if (pttState === PTT_STATES.IDLE) {
      return;
    }
    
    try {
      await stopPTT();
    } finally {
      if (transmitChannel) {
        signalPttEnd(transmitChannel);
      }
    }
  }, [pttState, stopPTT, transmitChannel, signalPttEnd]);

  // Spacebar PTT keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && !e.repeat) {
        const tagName = e.target?.tagName?.toLowerCase?.() ?? '';
        if (tagName === 'input' || tagName === 'textarea' || e.target?.isContentEditable) {
          return;
        }
        // Block PTT during emergency UNLESS in response window
        if (isEmergencyRef.current && !emergencyResponseWindowRef.current) {
          return;
        }
        e.preventDefault();
        handlePTTDown(e);
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        const tagName = e.target?.tagName?.toLowerCase?.() ?? '';
        if (tagName === 'input' || tagName === 'textarea' || e.target?.isContentEditable) {
          return;
        }
        e.preventDefault();
        handlePTTUp();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handlePTTDown, handlePTTUp]);

  const handleTouchStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.isTrusted) return;
    // Block PTT during emergency UNLESS in response window (waiting for user to respond to AI)
    if (isEmergency && !emergencyResponseWindow) return;
    
    setPttPressed(true);
    handlePTTDown(e);
  }, [isEmergency, emergencyResponseWindow, handlePTTDown]);

  const handleTouchEnd = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    handlePTTUp();
  }, [handlePTTUp]);

  const handleMouseDown = useCallback((e) => {
    if (!e.isTrusted) return;
    // Block PTT during emergency UNLESS in response window (waiting for user to respond to AI)
    if (isEmergency && !emergencyResponseWindow) return;
    
    setPttPressed(true);
    handlePTTDown(e);
  }, [isEmergency, emergencyResponseWindow, handlePTTDown]);

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

  const playEmergencyAlertSound = () => {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      
      const playTone = (startTime, frequency, duration) => {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();
        
        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);
        
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(frequency, startTime);
        
        gainNode.gain.setValueAtTime(0.6, startTime);
        gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
        
        oscillator.start(startTime);
        oscillator.stop(startTime + duration);
      };
      
      const now = audioContext.currentTime;
      playTone(now, 1800, 0.1);
      playTone(now + 0.12, 2200, 0.1);
      playTone(now + 0.24, 1800, 0.1);
      
      setTimeout(() => audioContext.close(), 500);
    } catch (e) {
      console.error('Failed to play emergency alert sound:', e);
    }
  };

  const triggerEmergency = async () => {
    const room = getCurrentRoom();
    if (!room || isEmergency) return;
    
    setIsEmergency(true);
    isEmergencyRef.current = true;
    setContextIsEmergency(true);
    
    playEmergencyAlertSound();
    
    broadcastEmergency(transmitChannel, true);
    broadcastStatus("emergency", transmitChannel);
    updateUnitPresence(transmitChannel, identity, "emergency", Date.now());
  };

  const cancelEmergency = async () => {
    const room = getCurrentRoom();
    if (!room) return;
    
    if (emergencyTimerRef.current) {
      clearInterval(emergencyTimerRef.current);
      emergencyTimerRef.current = null;
    }
    
    if (emergencyResponseTimeoutRef.current) {
      clearTimeout(emergencyResponseTimeoutRef.current);
      emergencyResponseTimeoutRef.current = null;
    }
    setEmergencyResponseWindow(false);
    emergencyResponseWindowRef.current = false;
    emergencyPausedForAIRef.current = false;
    
    await stopPTT();
    setIsEmergency(false);
    isEmergencyRef.current = false;
    setContextIsEmergency(false);
    
    rxAudioElementsRef.current.forEach(el => {
      el.muted = false;
    });
    
    broadcastEmergency(transmitChannel, false);
    broadcastStatus("idle", transmitChannel);
    updateUnitPresence(transmitChannel, identity, "idle", Date.now());
  };

  const handleToggleScanMode = useCallback(async () => {
    const newScanMode = !scanMode;
    setScanMode(newScanMode);
    await contextToggleScanMode(newScanMode, scanChannels, identity);
  }, [scanMode, scanChannels, identity, contextToggleScanMode]);

  const currentZoneChannels = zonesData[selectedZone] || [];
  
  const totalUnits = Object.values(unitPresence).reduce(
    (sum, channelUnits) => sum + Object.keys(channelUnits).length,
    0
  );

  const handleFirstInteraction = useCallback(() => {
    unlockAudio();
  }, []);

  return (
    <div 
      onClick={handleFirstInteraction}
      onTouchStart={handleFirstInteraction}
      style={{
      padding: "12px 12px 0 12px",
      fontFamily: "sans-serif",
      color: theme.text,
      background: theme.bg,
      height: "100dvh",
      maxHeight: "100dvh",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      boxSizing: "border-box",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexShrink: 0 }}>
        <h1 style={{ fontSize: 18, margin: 0, color: theme.text }}>Reeder PTT</h1>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={toggleDarkMode}
            style={{
              padding: "6px 10px",
              backgroundColor: theme.buttonBg,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {darkMode ? "☀️" : "🌙"}
          </button>
          {user?.role === "admin" && (
            <button
              onClick={() => navigate("/admin")}
              style={{
                padding: "6px 10px",
                backgroundColor: "#3b82f6",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Admin
            </button>
          )}
          {(user?.is_dispatcher || user?.role === "admin") && (
            <button
              onClick={() => navigate("/dispatcher")}
              style={{
                padding: "6px 10px",
                backgroundColor: "#6366f1",
                color: "white",
                border: "none",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              Dispatch
            </button>
          )}
          <button
            onClick={onLogout}
            style={{
              padding: "6px 10px",
              backgroundColor: "#dc2626",
              color: "white",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Logout
          </button>
        </div>
      </div>

      {noChannelsAccess ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 18, marginBottom: 16, color: "#dc2626" }}>No Channel Access</div>
          <div style={{ fontSize: 14, color: theme.textSecondary, marginBottom: 16 }}>
            You do not have access to any radio channels.
          </div>
          <div style={{ fontSize: 14, color: theme.textSecondary }}>
            Please contact your administrator to request channel access.
          </div>
        </div>
      ) : connectionError ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 18, marginBottom: 16, color: "#dc2626" }}>Connection Error</div>
          <div style={{ fontSize: 14, color: theme.textSecondary, marginBottom: 16 }}>{connectionError}</div>
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
        <div style={{ textAlign: "center", padding: 40, flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div style={{ fontSize: 18, marginBottom: 16 }}>Connecting to radio network...</div>
          <div style={{ fontSize: 14, color: theme.textSecondary }}>Unit: {identity}</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
          {/* Compact channel info header */}
          <div style={{ 
            display: "flex", 
            justifyContent: "space-between", 
            alignItems: "center",
            marginBottom: 8,
            flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div>
                <div style={{ fontSize: 10, opacity: 0.5 }}>{selectedZone.split(" - ")[1] || selectedZone}</div>
                <h2 style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 6 }}>
                  <StatusDot status={isTalking ? "transmitting" : activeAudio ? "transmitting" : "idle"} />
                  {getDisplayName(selectedChannel)}
                </h2>
              </div>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <button
                onClick={() => setShowSettings(!showSettings)}
                style={{
                  padding: "6px 8px",
                  backgroundColor: showSettings ? "#3b82f6" : theme.buttonBg,
                  color: theme.text,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                ⚙️
              </button>
              <button
                onClick={() => setShowUnits(!showUnits)}
                style={{
                  padding: "6px 8px",
                  backgroundColor: showUnits ? "#3b82f6" : theme.buttonBg,
                  color: theme.text,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                👥 {totalUnits}
              </button>
            </div>
          </div>

          {/* Zone and channel selection - compact */}
          <div style={{ marginBottom: 8, flexShrink: 0 }}>
            <div style={{ display: "flex", gap: 4, marginBottom: 4, flexWrap: "wrap" }}>
              {Object.keys(zonesData).map((zone) => (
                <button
                  key={zone}
                  onClick={() => {
                    setSelectedZone(zone);
                    const firstChannel = zonesData[zone][0];
                    switchChannel(firstChannel);
                  }}
                  style={{
                    padding: "4px 8px",
                    backgroundColor: zone === selectedZone ? "#6366f1" : theme.bgTertiary,
                    color: theme.text,
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 10,
                  }}
                >
                  {zone.replace("Zone ", "Z").split(" - ")[0]}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {currentZoneChannels.map((ch) => (
                <button
                  key={ch}
                  onClick={() => switchChannel(ch)}
                  style={{
                    padding: "6px 10px",
                    backgroundColor: ch === selectedChannel ? "#3b82f6" : theme.buttonBg,
                    color: theme.text,
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {getDisplayName(ch)}
                </button>
              ))}
            </div>
          </div>

          {/* Collapsible Settings Panel */}
          {showSettings && (
            <div style={{ 
              background: theme.bgSecondary, 
              padding: 8, 
              borderRadius: 6,
              marginBottom: 8,
              flexShrink: 0,
            }}>
              <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                <button
                  onClick={handleToggleScanMode}
                  style={{
                    padding: "3px 8px",
                    backgroundColor: scanMode ? "#f59e0b" : theme.buttonBg,
                    color: theme.text,
                    border: "none",
                    borderRadius: 3,
                    cursor: "pointer",
                    fontSize: 10,
                  }}
                >
                  Scan {scanMode ? "ON" : "OFF"}
                </button>
                {lastRxBlob && (
                  <button
                    onClick={playLastRx}
                    disabled={isPlayingRecording}
                    style={{
                      padding: "3px 8px",
                      backgroundColor: isPlayingRecording ? theme.textMuted : theme.buttonBg,
                      color: theme.text,
                      border: "none",
                      borderRadius: 3,
                      cursor: isPlayingRecording ? "default" : "pointer",
                      fontSize: 10,
                    }}
                  >
                    {isPlayingRecording ? "Playing..." : "Replay RX"}
                  </button>
                )}
              </div>
              {scanMode && (
                <div style={{ marginTop: 6, maxHeight: 80, overflowY: "auto" }}>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {Object.values(zonesData).flat().filter(ch => ch !== selectedChannel).map((ch) => (
                      <button
                        key={ch}
                        onClick={() => toggleScanChannel(ch)}
                        style={{
                          padding: "2px 6px",
                          backgroundColor: scanChannels.includes(ch) ? "#22c55e" : theme.buttonBg,
                          color: theme.text,
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          fontSize: 9,
                        }}
                      >
                        {getDisplayName(ch)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Collapsible Units Panel */}
          {showUnits && (
            <div style={{ 
              background: theme.bgSecondary, 
              padding: 8, 
              borderRadius: 6,
              marginBottom: 8,
              maxHeight: 100,
              overflowY: "auto",
              flexShrink: 0,
            }}>
              {Object.entries(unitPresence).map(([channel, units]) => (
                Object.keys(units).length > 0 && (
                  <div key={channel} style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 9, opacity: 0.5 }}>{getDisplayName(channel)}</div>
                    {Object.entries(units).map(([unitId, info]) => (
                      <div key={unitId} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                        <StatusDot status={info.status} />
                        {unitId}
                      </div>
                    ))}
                  </div>
                )
              ))}
              {totalUnits === 0 && <p style={{ opacity: 0.5, margin: 0, fontSize: 11 }}>No other units online</p>}
            </div>
          )}

          {/* Active audio indicator */}
          {activeAudio && (
            <div style={{
              background: "#1e40af",
              padding: 8,
              borderRadius: 6,
              marginBottom: 8,
              textAlign: "center",
              fontSize: 12,
              flexShrink: 0,
            }}>
              <StatusDot status="transmitting" />
              RX: {activeAudio.from} on {getDisplayName(activeAudio.channel)}
            </div>
          )}

          {/* Emergency alerts */}
          {Object.keys(activeEmergencies).length > 0 && (
            <div style={{
              background: emergencyFlash ? "#dc2626" : "#7f1d1d",
              padding: 8,
              borderRadius: 6,
              marginBottom: 8,
              border: "2px solid #dc2626",
              flexShrink: 0,
            }}>
              {Object.entries(activeEmergencies).map(([unitId, info]) => (
                <div key={unitId} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12 }}>
                    <StatusDot status="emergency" />
                    {unitId} EMERGENCY
                  </span>
                  <button
                    onClick={() => acknowledgeEmergency(unitId, info.channel)}
                    style={{ padding: "3px 8px", backgroundColor: "#22c55e", color: "white", border: "none", borderRadius: 3, fontSize: 10 }}
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
              padding: 10,
              borderRadius: 6,
              marginBottom: 8,
              textAlign: "center",
              border: "2px solid #dc2626",
              flexShrink: 0,
            }}>
              <div style={{ fontSize: 14, fontWeight: "bold" }}>EMERGENCY ACTIVE</div>
              <button
                onClick={cancelEmergency}
                style={{ marginTop: 6, padding: "4px 12px", backgroundColor: theme.textMuted, color: theme.text, border: "none", borderRadius: 4, fontSize: 11 }}
              >
                Cancel
              </button>
            </div>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* TX/RX indicator */}
          <div style={{ 
            background: theme.bgSecondary, 
            padding: 6, 
            borderRadius: 6,
            marginBottom: 8,
            textAlign: "center",
            fontSize: 11,
            flexShrink: 0,
          }}>
            TX: {getDisplayName(transmitChannel)} | RX: {[selectedChannel, ...scanChannels].map(getDisplayName).join(", ")}
          </div>

          {/* Fixed bottom buttons */}
          <div style={{ flexShrink: 0, paddingBottom: 12 }}>
            <button
              onClick={triggerEmergency}
              disabled={isEmergency}
              style={{
                padding: 12,
                width: "100%",
                backgroundColor: isEmergency ? "#7f1d1d" : "#f97316",
                color: "white",
                fontSize: 14,
                fontWeight: "bold",
                border: "2px solid #f97316",
                borderRadius: 8,
                cursor: isEmergency ? "default" : "pointer",
                marginBottom: 8,
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
              disabled={isEmergency || activeAudio}
              style={{
                padding: 24,
                width: "100%",
                minHeight: "45vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: (pttPressed || isTalking) 
                  ? "#f97316"
                  : activeAudio 
                    ? "#dc2626"
                    : "#22c55e",
                color: "white",
                fontSize: 24,
                fontWeight: "bold",
                border: "none",
                borderRadius: 12,
                cursor: (isEmergency || activeAudio) ? "default" : "pointer",
                boxShadow: (pttPressed || isTalking) 
                  ? "0 0 30px rgba(249, 115, 22, 0.6)"
                  : activeAudio 
                    ? "0 0 30px rgba(220, 38, 38, 0.6)" 
                    : "0 0 20px rgba(34, 197, 94, 0.4)",
                transition: "background-color 0.05s, box-shadow 0.05s",
                opacity: isEmergency ? 0.5 : 1,
                touchAction: "none",
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {isTalking ? "TRANSMITTING..." : activeAudio ? `RX: ${activeAudio.from}` : "PUSH TO TALK"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
