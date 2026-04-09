import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { audioTransportManager } from '../audio/AudioTransportManager.js';
import { signalingManager } from '../signaling/SignalingManager.js';
import { getChannels } from '../utils/api.js';
import useDispatchStore from '../state/dispatchStore.js';

const AudioConnectionContext = createContext(null);

const RECONNECT_FAST_DELAY = 1500;
const RECONNECT_FAST_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 15000;
const RECONNECT_BACKOFF_ATTEMPTS = 10;
const RECONNECT_SUSTAINED_INTERVAL = 15000;
const STABILITY_THRESHOLD = 5000;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export function AudioConnectionProvider({ children, user }) {
  const location = useLocation();
  const identity = (user?.unit_id && user.unit_id.trim()) || user?.username || "Unknown";
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [connectionHealth, setConnectionHealth] = useState({ status: 'disconnected', healthy: 0, total: 0 });
  const [activeChannel, setActiveChannel] = useState(null);
  const [scanMode, setScanMode] = useState(false);
  const [scanChannels, setScanChannels] = useState([]);
  
  const reconnectAttempts = useRef(new Map());
  const reconnectTimers = useRef(new Map());
  const connectionStartTimes = useRef(new Map());
  const mountedRef = useRef(true);
  const initializingRef = useRef(false);
  const lastUserRef = useRef(null);
  const lastPathRef = useRef(null);
  const idleTimerRef = useRef(null);
  const lastActivityRef = useRef(Date.now());
  const micStreamRef = useRef(null);
  const switchCounterRef = useRef(0);
  const latestSwitchTargetRef = useRef(null);
  const intentionalDisconnectsRef = useRef(new Set());
  
  const {
    channels: storeChannels,
    setChannels,
    setConnected,
    setConnecting,
    setConnectionError,
  } = useDispatchStore();

  const clearReconnectTimer = useCallback((channelName) => {
    const timer = reconnectTimers.current.get(channelName);
    if (timer) {
      clearTimeout(timer);
      reconnectTimers.current.delete(channelName);
    }
  }, []);

  const clearAllReconnectTimers = useCallback(() => {
    for (const [channelName] of reconnectTimers.current) {
      clearReconnectTimer(channelName);
    }
    reconnectAttempts.current.clear();
    connectionStartTimes.current.clear();
  }, [clearReconnectTimer]);

  const recordActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  const scheduleReconnect = useCallback((channelName, identity) => {
    if (!mountedRef.current) return;
    if (intentionalDisconnectsRef.current.has(channelName)) return;
    
    const startTime = connectionStartTimes.current.get(channelName);
    const wasStable = startTime && (Date.now() - startTime) > STABILITY_THRESHOLD;
    
    if (wasStable) {
      reconnectAttempts.current.delete(channelName);
      connectionStartTimes.current.delete(channelName);
      console.log(`[AudioConnection] Connection to ${channelName} was stable, resetting attempts`);
    }
    
    const attempts = reconnectAttempts.current.get(channelName) || 0;
    
    let delay;
    if (attempts < RECONNECT_FAST_ATTEMPTS) {
      delay = RECONNECT_FAST_DELAY + Math.random() * 500;
    } else if (attempts < RECONNECT_BACKOFF_ATTEMPTS) {
      const backoffAttempt = attempts - RECONNECT_FAST_ATTEMPTS;
      const baseDelay = RECONNECT_BASE_DELAY * Math.pow(2, backoffAttempt);
      const jitter = Math.random() * 1000;
      delay = Math.min(baseDelay + jitter, RECONNECT_MAX_DELAY);
    } else {
      delay = RECONNECT_SUSTAINED_INTERVAL + Math.random() * 2000;
    }
    
    console.log(`[AudioConnection] Scheduling reconnect for ${channelName} in ${Math.round(delay)}ms (attempt ${attempts + 1})`);
    
    clearReconnectTimer(channelName);
    
    const timer = setTimeout(async () => {
      if (!mountedRef.current) return;
      
      reconnectAttempts.current.set(channelName, attempts + 1);
      
      try {
        await audioTransportManager.connect(channelName, identity);
        reconnectAttempts.current.delete(channelName);
        connectionStartTimes.current.set(channelName, Date.now());
        lastActivityRef.current = Date.now();
        console.log(`[AudioConnection] Reconnected to ${channelName}`);
      } catch (err) {
        console.error(`[AudioConnection] Reconnect failed for ${channelName}:`, err);
        scheduleReconnect(channelName, identity);
      }
    }, delay);
    
    reconnectTimers.current.set(channelName, timer);
  }, [clearReconnectTimer]);

  const getMonitoredRoomKeys = useCallback(() => {
    const state = useDispatchStore.getState();
    const chList = state.channels || [];
    return new Set(
      (state.monitoredChannelIds || [])
        .map(id => {
          const ch = chList.find(c => c.id === id);
          return ch ? (ch.room_key || ((ch.zone || 'Default') + '__' + ch.name)) : null;
        })
        .filter(Boolean)
    );
  }, []);

  const listenerRemoversRef = useRef([]);
  
  const setupEventHandlers = useCallback((identity) => {
    listenerRemoversRef.current.forEach(remove => remove());
    listenerRemoversRef.current = [];
    
    audioTransportManager.startSettingsListener();
    
    listenerRemoversRef.current.push(
      audioTransportManager.addLevelUpdateListener((channelName, level) => {
        const channels = useDispatchStore.getState().channels;
        const channel = channels.find(c => (c.room_key || ((c.zone || 'Default') + '__' + c.name)) === channelName);
        if (channel) {
          useDispatchStore.getState().setChannelLevel(channel.id, level);
        }
      })
    );
    
    listenerRemoversRef.current.push(
      audioTransportManager.addTrackSubscribedListener((channelName, track, participant) => {
        recordActivity();
      })
    );
    
    listenerRemoversRef.current.push(
      audioTransportManager.addTrackUnsubscribedListener((channelName, track, participant) => {
      })
    );
    
    listenerRemoversRef.current.push(
      audioTransportManager.addParticipantConnectedListener((channelName, participant) => {
        useDispatchStore.getState().addEvent({
          type: 'unit_joined',
          unit: participant.identity,
          channel: channelName,
        });
      })
    );
    
    listenerRemoversRef.current.push(
      audioTransportManager.addParticipantDisconnectedListener((channelName, participant) => {
        useDispatchStore.getState().addEvent({
          type: 'unit_left',
          unit: participant.identity,
          channel: channelName,
        });
      })
    );
    
    listenerRemoversRef.current.push(
      audioTransportManager.addDataReceivedListener((channelName, message, participant) => {
        recordActivity();
        if (message.type === 'emergency') {
          if (message.active) {
            const store = useDispatchStore.getState();
            const unitId = participant?.identity || message.identity;
            const already = store.emergencies.some(e => e.unitIdentity === unitId);
            if (!already) {
              store.addEmergency({
                id: `emergency-${unitId}-${Date.now()}`,
                unitIdentity: unitId,
                channel: channelName,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      })
    );
    
    const addEmergencyIfNew = (data, source) => {
      const store = useDispatchStore.getState();
      const already = store.emergencies.some(e => e.unitIdentity === data.unitId);
      if (already) return;
      console.log('[AudioConnection] Emergency via ' + source + ':', data);
      store.addEmergency({
        id: 'sig-emergency-' + (data.unitId || 'unknown') + '-' + Date.now(),
        unitIdentity: data.unitId,
        channel: data.channelId,
        timestamp: new Date().toISOString(),
      });
    };

    const removeSignalingEmergency = signalingManager.on('emergencyStart', (data) => {
      addEmergencyIfNew(data, 'emergencyStart');
    });
    listenerRemoversRef.current.push(removeSignalingEmergency);

    const removeSignalingAlert = signalingManager.on('emergencyAlert', (data) => {
      addEmergencyIfNew(data, 'emergencyAlert');
    });
    listenerRemoversRef.current.push(removeSignalingAlert);

    const removeSignalingEmergencyEnd = signalingManager.on('emergencyEnd', (data) => {
      console.log('[AudioConnection] Emergency END via signaling:', data);
      const store = useDispatchStore.getState();
      const matches = store.emergencies.filter(e =>
        e.unitIdentity === data.unitId
      );
      matches.forEach(match => store.removeEmergency(match.id));
    });
    listenerRemoversRef.current.push(removeSignalingEmergencyEnd);

    const removeSignalingReconnect = signalingManager.on('connectionChange', (data) => {
      if (data.connected) {
        console.log('[AudioConnection] Signaling reconnected — verifying audio WebSockets');
        if (audioTransportManager.isDispatcherMode()) {
          const monitoredKeys = getMonitoredRoomKeys();
          audioTransportManager.verifyAndReconnectAll(monitoredKeys).then((count) => {
            if (count > 0) {
              console.log(`[AudioConnection] Recovered ${count} dead audio WebSocket(s) after signaling reconnect (dispatcher, filtered)`);
            }
          }).catch((err) => {
            console.error('[AudioConnection] Audio recovery after signaling reconnect failed:', err.message);
          });
        } else {
          audioTransportManager.verifyAndReconnectAll().then((count) => {
            if (count > 0) {
              console.log(`[AudioConnection] Recovered ${count} dead audio WebSocket(s) after signaling reconnect`);
            }
          }).catch((err) => {
            console.error('[AudioConnection] Audio recovery after signaling reconnect failed:', err.message);
          });
        }
      }
    });
    listenerRemoversRef.current.push(removeSignalingReconnect);

    const removeSignalingPttStart = signalingManager.on('pttStart', (data) => {
      if (data.unitId === identity || data.unitId === user?.username) {
        return;
      }
      const store = useDispatchStore.getState();
      store.setActiveTransmission(data.channelId, {
        from: data.unitId,
        timestamp: Date.now(),
      });
      store.addEvent({
        type: 'ptt_start',
        unit: data.unitId,
        channel: data.channelId,
      });
    });
    listenerRemoversRef.current.push(removeSignalingPttStart);

    const removeSignalingPttEnd = signalingManager.on('pttEnd', (data) => {
      const store = useDispatchStore.getState();
      store.clearActiveTransmission(data.channelId);
      store.addEvent({
        type: 'ptt_end',
        unit: data.unitId,
        channel: data.channelId,
      });
    });
    listenerRemoversRef.current.push(removeSignalingPttEnd);

    listenerRemoversRef.current.push(
      audioTransportManager.addConnectionStateChangeListener((channelName, state, error) => {
        console.log(`[AudioConnection] ${channelName} state: ${state}`);
        
        if (mountedRef.current) {
          setConnectionHealth(audioTransportManager.getConnectionStatus());
        }
        
        if (state === 'disconnected' && mountedRef.current) {
          if (intentionalDisconnectsRef.current.has(channelName)) {
            console.log(`[AudioConnection] Skipping reconnect for intentionally disconnected ${channelName}`);
          } else if (audioTransportManager.isDispatcherMode()) {
            const monitoredKeys = getMonitoredRoomKeys();
            if (monitoredKeys.has(channelName)) {
              scheduleReconnect(channelName, identity);
            } else {
              console.log(`[AudioConnection] Skipping reconnect for unmonitored channel ${channelName}`);
            }
          } else {
            scheduleReconnect(channelName, identity);
          }
        }
      })
    );
    
    listenerRemoversRef.current.push(
      audioTransportManager.addHealthChangeListener((channelName, health) => {
        console.log(`[AudioConnection] Health change for ${channelName}:`, health);
        if (mountedRef.current) {
          setConnectionHealth(audioTransportManager.getConnectionStatus());
        }
      })
    );
  }, [scheduleReconnect, recordActivity, getMonitoredRoomKeys]);

  const preCaptureForMobile = useCallback(async () => {
  }, []);

  const releaseMobileMic = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
      console.log('[AudioConnection] Mobile mic released');
    }
  }, []);

  const connectToChannel = useCallback(async (channelName, identity, markActive = true) => {
    if (!channelName || !identity) return false;
    
    intentionalDisconnectsRef.current.delete(channelName);
    recordActivity();
    
    try {
      const tConnect = performance.now();
      await Promise.all([
        preCaptureForMobile(),
        audioTransportManager.connect(channelName, identity)
      ]);
      console.log(`[AudioConnection] connectToChannel total for ${channelName}: ${(performance.now() - tConnect).toFixed(1)}ms`);
      connectionStartTimes.current.set(channelName, Date.now());
      
      if (markActive) {
        audioTransportManager.setChannelActive(channelName);
      }
      
      console.log(`[AudioConnection] Connected to ${channelName}`);
      return true;
    } catch (err) {
      console.error(`[AudioConnection] Failed to connect to ${channelName}:`, err);
      if (!audioTransportManager.isDispatcherMode()) {
        scheduleReconnect(channelName, identity);
      }
      return false;
    }
  }, [recordActivity, preCaptureForMobile, scheduleReconnect]);

  const disconnectFromChannel = useCallback(async (channelName) => {
    intentionalDisconnectsRef.current.add(channelName);
    clearReconnectTimer(channelName);
    audioTransportManager.setChannelInactive(channelName);
    await audioTransportManager.disconnect(channelName);
    console.log(`[AudioConnection] Intentionally disconnected from ${channelName}`);
  }, [clearReconnectTimer]);

  const switchChannel = useCallback(async (newChannelName, callerIdentity, isDispatcher = false) => {
    const resolvedIdentity = callerIdentity || identity;
    if (!newChannelName || !resolvedIdentity) {
      console.warn('[AudioConnection] switchChannel called without channelName or identity', { newChannelName, resolvedIdentity });
      return;
    }
    
    recordActivity();
    
    const currentPath = location.pathname;
    const isDispatcherRoute = currentPath === '/dispatcher';
    
    if (isDispatcherRoute || isDispatcher) {
      await connectToChannel(newChannelName, resolvedIdentity);
      return;
    }
    
    const switchId = ++switchCounterRef.current;
    latestSwitchTargetRef.current = newChannelName;
    
    const channelsToKeep = scanMode 
      ? [newChannelName, ...scanChannels.filter(ch => ch !== newChannelName)]
      : [newChannelName];
    
    const currentChannels = audioTransportManager.getConnectedChannels();
    for (const ch of currentChannels) {
      if (!channelsToKeep.includes(ch)) {
        await disconnectFromChannel(ch);
      }
    }
    
    if (switchId !== switchCounterRef.current) {
      console.log(`[AudioConnection] switchChannel superseded (wanted ${newChannelName}, newer switch pending)`);
      return;
    }
    
    if (!audioTransportManager.isConnected(newChannelName)) {
      await connectToChannel(newChannelName, resolvedIdentity);
    }
    
    if (switchId !== switchCounterRef.current) {
      console.log(`[AudioConnection] switchChannel superseded after connect (wanted ${newChannelName}, newer switch pending)`);
      if (latestSwitchTargetRef.current !== newChannelName) {
        await disconnectFromChannel(newChannelName);
      }
      return;
    }
    
    setActiveChannel(newChannelName);
    setConnectionHealth(audioTransportManager.getConnectionStatus());
    
    const connectedCount = audioTransportManager.getConnectedChannels().length;
    if (connectedCount > 0) {
      setConnected(true);
      setConnectionStatus('connected');
    }
  }, [identity, recordActivity, connectToChannel, disconnectFromChannel, scanMode, scanChannels, location.pathname, setConnected]);

  const toggleScanMode = useCallback(async (enabled, channelsToScan, identity) => {
    recordActivity();
    setScanMode(enabled);
    const newScanChannels = channelsToScan || [];
    setScanChannels(newScanChannels);
    
    const currentChannels = audioTransportManager.getConnectedChannels();
    const channelsToKeep = enabled 
      ? [activeChannel, ...newScanChannels].filter(Boolean)
      : [activeChannel].filter(Boolean);
    
    for (const ch of currentChannels) {
      if (!channelsToKeep.includes(ch)) {
        console.log(`[AudioConnection] Disconnecting from ${ch} (not in keep list)`);
        await disconnectFromChannel(ch);
      }
    }
    
    if (enabled && newScanChannels.length > 0) {
      console.log(`[AudioConnection] Scan mode ON - connecting to ${newScanChannels.length} channels`);
      for (const ch of newScanChannels) {
        if (!audioTransportManager.isConnected(ch)) {
          await connectToChannel(ch, identity);
        }
      }
    }
    
    setConnectionHealth(audioTransportManager.getConnectionStatus());
  }, [recordActivity, connectToChannel, disconnectFromChannel, activeChannel]);

  const initializeConnections = useCallback(async (identity, channelsData, initialChannel = null) => {
    if (initializingRef.current) {
      console.log('[AudioConnection] Already initializing, skipping');
      return;
    }
    
    initializingRef.current = true;
    setConnecting(true);
    setConnectionError(null);
    setConnectionStatus('connecting');
    
    try {
      setupEventHandlers(identity);
      
      const enabledChannels = channelsData.filter(ch => ch.enabled);
      
      if (enabledChannels.length === 0) {
        console.log('[AudioConnection] No enabled channels available');
        setConnected(false);
        setConnectionStatus('idle');
        return;
      }
      
      const currentPath = location.pathname;
      const isDispatcher = currentPath === '/dispatcher';
      
      if (isDispatcher) {
        console.log(`[AudioConnection] Dispatcher mode - skipping audio connections at init; monitoring effect will drive connections`);
        audioTransportManager.setDispatcherMode(true);
        setConnected(true);
        setConnectionStatus('connected');
      } else {
        const firstChannel = initialChannel || enabledChannels[0]?.room_key || enabledChannels[0]?.name;
        if (firstChannel) {
          console.log(`[AudioConnection] Radio mode - setting active channel to ${firstChannel}`);
          setActiveChannel(firstChannel);
          setConnected(true);
          setConnectionStatus('connected');
          
          const success = await connectToChannel(firstChannel, identity);
          if (!success) {
            console.warn(`[AudioConnection] Initial audio transport connect to ${firstChannel} failed - will retry on transmit`);
          }
        }
      }
      
      setConnectionHealth(audioTransportManager.getConnectionStatus());
      
    } catch (err) {
      console.error('[AudioConnection] Initialization failed:', err);
      setConnectionError(err.message || 'Connection failed');
      setConnectionStatus('failed');
    } finally {
      initializingRef.current = false;
      setConnecting(false);
    }
  }, [setupEventHandlers, setConnected, setConnecting, setConnectionError, connectToChannel, location.pathname]);

  const disconnectAll = useCallback(async () => {
    console.log('[AudioConnection] Disconnecting all');
    audioTransportManager.setDispatcherMode(false);
    clearAllReconnectTimers();
    releaseMobileMic();
    await audioTransportManager.disconnectAll();
    setConnected(false);
    setConnectionStatus('idle');
    setActiveChannel(null);
    initializingRef.current = false;
    lastUserRef.current = null;
  }, [clearAllReconnectTimers, setConnected, releaseMobileMic]);

  const retryConnection = useCallback(async () => {
    if (!user) return;
    
    console.log('[AudioConnection] Retrying connection...');
    recordActivity();
    clearAllReconnectTimers();
    initializingRef.current = false;
    lastUserRef.current = null;
    await audioTransportManager.disconnectAll();
    
    try {
      const data = await getChannels();
      const fetchedChannels = data.channels || [];
      setChannels(fetchedChannels);
      lastUserRef.current = identity;
      await initializeConnections(identity, fetchedChannels);
    } catch (err) {
      console.error('[AudioConnection] Retry failed:', err);
      setConnectionError(err.message);
      lastUserRef.current = null;
    }
  }, [user, recordActivity, clearAllReconnectTimers, setChannels, initializeConnections, setConnectionError]);

  const ensureConnected = useCallback(async (channelName) => {
    if (!user) return false;
    
    recordActivity();
    
    if (audioTransportManager.isConnected(channelName)) {
      return true;
    }
    
    console.log(`[AudioConnection] Reconnecting to ${channelName} after idle...`);
    return await connectToChannel(channelName, identity);
  }, [identity, recordActivity, connectToChannel]);

  useEffect(() => {
    if (idleTimerRef.current) {
      clearInterval(idleTimerRef.current);
    }
    
    const currentPath = location.pathname;
    const isDispatcher = currentPath === '/dispatcher';
    const isRadio = currentPath === '/';
    const isAdmin = currentPath === '/admin';
    
    audioTransportManager.setDispatcherMode(isDispatcher);

    if (isDispatcher || isRadio || isAdmin) {
      console.log(`[AudioConnection] ${isDispatcher ? 'Dispatcher' : isAdmin ? 'Admin' : 'Radio'} mode - idle timeout disabled (audio must persist)`);
      return;
    }
    
    idleTimerRef.current = setInterval(() => {
      const idleTime = Date.now() - lastActivityRef.current;
      
      if (idleTime >= IDLE_TIMEOUT) {
        console.log(`[AudioConnection] Idle for ${Math.round(idleTime / 1000)}s - disconnecting to save costs`);
        
        const connectedChannels = audioTransportManager.getConnectedChannels();
        connectedChannels.forEach(ch => {
          audioTransportManager.disconnect(ch);
        });
        
        releaseMobileMic();
        setConnectionStatus('idle');
        setConnected(false);
      }
    }, 30000);
    
    return () => {
      if (idleTimerRef.current) {
        clearInterval(idleTimerRef.current);
      }
    };
  }, [location.pathname, setConnected, releaseMobileMic]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && user) {
        console.log('[AudioConnection] Page became visible — checking audio channels');
        lastActivityRef.current = Date.now();

        const connectedChannels = audioTransportManager.getConnectedChannels();
        const monitoredKeys = audioTransportManager.isDispatcherMode() ? getMonitoredRoomKeys() : null;
        let reconnectedCount = 0;

        for (const channelName of connectedChannels) {
          if (intentionalDisconnectsRef.current.has(channelName)) {
            console.log(`[AudioConnection] Skipping visibility reconnect for intentionally disconnected ${channelName}`);
            continue;
          }
          if (monitoredKeys && !monitoredKeys.has(channelName)) {
            console.log(`[AudioConnection] Skipping visibility reconnect for unmonitored channel ${channelName}`);
            continue;
          }
          const conn = audioTransportManager.getRoom(channelName);
          if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            continue;
          }
          const unitId = (conn && conn.unitId) || identity;
          console.log(`[AudioConnection] Audio WS dead for ${channelName} after visibility restore — reconnecting`);
          audioTransportManager.disconnect(channelName).then(() => {
            connectToChannel(channelName, unitId);
          });
          reconnectedCount++;
        }

        if (reconnectedCount === 0 && connectedChannels.length === 0 && connectionStatus !== 'idle') {
          console.log('[AudioConnection] No audio channels connected after visibility restore — retrying');
          retryConnection();
        } else if (reconnectedCount === 0) {
          console.log('[AudioConnection] All audio channels healthy after visibility restore');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, identity, connectionStatus, connectToChannel, retryConnection, getMonitoredRoomKeys]);

  useEffect(() => {
    mountedRef.current = true;
    const currentPath = location.pathname;
    
    const init = async () => {
      console.log('[AudioConnection] Init check - user:', user?.username, 'lastUser:', lastUserRef.current, 'initializing:', initializingRef.current, 'path:', currentPath);
      
      const shouldConnect = currentPath === '/' || currentPath === '/dispatcher' || currentPath === '/admin';
      if (!shouldConnect) {
        console.log('[AudioConnection] Not on radio, dispatcher, or admin route, skipping auto-connect');
        return;
      }
      
      if (!user) {
        console.log('[AudioConnection] No user, skipping init');
        return;
      }
      
      if (initializingRef.current) {
        console.log('[AudioConnection] Already initializing, skipping');
        return;
      }
      
      if (lastUserRef.current === identity && lastPathRef.current === currentPath) {
        console.log('[AudioConnection] Already initialized for this user on this path, skipping');
        return;
      }
      
      lastUserRef.current = identity;
      lastPathRef.current = currentPath;
      
      try {
        console.log('[AudioConnection] Fetching channels...');
        const data = await getChannels();
        const fetchedChannels = data.channels || [];
        console.log('[AudioConnection] Fetched', fetchedChannels.length, 'channels');
        setChannels(fetchedChannels);

        audioTransportManager.prepareConnection();
        
        if (fetchedChannels.length > 0) {
          await initializeConnections(identity, fetchedChannels);
        } else {
          console.log('[AudioConnection] No channels to connect to');
          setConnected(false);
          setConnectionStatus('idle');
        }
      } catch (err) {
        console.error('[AudioConnection] Failed to fetch channels:', err);
        setConnectionError(err.message);
        lastUserRef.current = null;
      }
    };
    
    init();
    
    return () => {
      mountedRef.current = false;
    };
  }, [user, location.pathname, setChannels, initializeConnections, setConnectionError, setConnected]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearAllReconnectTimers();
      releaseMobileMic();
      if (idleTimerRef.current) {
        clearInterval(idleTimerRef.current);
      }
    };
  }, [clearAllReconnectTimers, releaseMobileMic]);

  const value = {
    connectionStatus,
    connectionHealth,
    activeChannel,
    scanMode,
    scanChannels,
    disconnectAll,
    retryConnection,
    audioTransportManager,
    channels: storeChannels,
    switchChannel,
    toggleScanMode,
    ensureConnected,
    recordActivity,
    connectToChannel,
    disconnectFromChannel,
  };

  return (
    <AudioConnectionContext.Provider value={value}>
      {children}
    </AudioConnectionContext.Provider>
  );
}

export function useAudioConnection() {
  const context = useContext(AudioConnectionContext);
  if (!context) {
    throw new Error('useAudioConnection must be used within AudioConnectionProvider');
  }
  return context;
}

export default AudioConnectionContext;


// Legacy aliases for backward compatibility during rename cleanup.
export const LiveKitConnectionContext = AudioConnectionContext;
export const LiveKitConnectionProvider = AudioConnectionProvider;
export const useLiveKitConnection = useAudioConnection;
