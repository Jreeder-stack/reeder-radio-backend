import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { livekitManager } from '../audio/LiveKitManager.js';
import { onDemandVoiceManager } from '../audio/OnDemandVoiceManager.js';
import { signalingManager } from '../signaling/SignalingManager.js';
import { getChannels } from '../utils/api.js';
import useDispatchStore from '../state/dispatchStore.js';

const LiveKitConnectionContext = createContext(null);

const RECONNECT_BASE_DELAY = 2000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;
const STABILITY_THRESHOLD = 5000;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export function LiveKitConnectionProvider({ children, user }) {
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
    
    const startTime = connectionStartTimes.current.get(channelName);
    const wasStable = startTime && (Date.now() - startTime) > STABILITY_THRESHOLD;
    
    if (wasStable) {
      reconnectAttempts.current.delete(channelName);
      connectionStartTimes.current.delete(channelName);
      console.log(`[LiveKitConnection] Connection to ${channelName} was stable, resetting attempts`);
    }
    
    const attempts = reconnectAttempts.current.get(channelName) || 0;
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      console.log(`[LiveKitConnection] Max reconnect attempts reached for ${channelName}`);
      return;
    }
    
    const baseDelay = RECONNECT_BASE_DELAY * Math.pow(2, attempts);
    const jitter = Math.random() * 1000;
    const delay = Math.min(baseDelay + jitter, RECONNECT_MAX_DELAY);
    
    console.log(`[LiveKitConnection] Scheduling reconnect for ${channelName} in ${Math.round(delay)}ms (attempt ${attempts + 1})`);
    
    clearReconnectTimer(channelName);
    
    const timer = setTimeout(async () => {
      if (!mountedRef.current) return;
      
      reconnectAttempts.current.set(channelName, attempts + 1);
      
      try {
        await livekitManager.connect(channelName, identity);
        connectionStartTimes.current.set(channelName, Date.now());
        lastActivityRef.current = Date.now(); // Reset idle timer on reconnect
        console.log(`[LiveKitConnection] Reconnected to ${channelName}`);
      } catch (err) {
        console.error(`[LiveKitConnection] Reconnect failed for ${channelName}:`, err);
        scheduleReconnect(channelName, identity);
      }
    }, delay);
    
    reconnectTimers.current.set(channelName, timer);
  }, [clearReconnectTimer]);

  const listenerRemoversRef = useRef([]);
  
  const setupEventHandlers = useCallback((identity) => {
    listenerRemoversRef.current.forEach(remove => remove());
    listenerRemoversRef.current = [];
    
    livekitManager.startSettingsListener();
    
    listenerRemoversRef.current.push(
      livekitManager.addLevelUpdateListener((channelName, level) => {
        const channels = useDispatchStore.getState().channels;
        const channel = channels.find(c => (c.room_key || ((c.zone || 'Default') + '__' + c.name)) === channelName);
        if (channel) {
          useDispatchStore.getState().setChannelLevel(channel.id, level);
        }
      })
    );
    
    listenerRemoversRef.current.push(
      livekitManager.addTrackSubscribedListener((channelName, track, participant) => {
        recordActivity();
      })
    );
    
    listenerRemoversRef.current.push(
      livekitManager.addTrackUnsubscribedListener((channelName, track, participant) => {
      })
    );
    
    listenerRemoversRef.current.push(
      livekitManager.addParticipantConnectedListener((channelName, participant) => {
        useDispatchStore.getState().addEvent({
          type: 'unit_joined',
          unit: participant.identity,
          channel: channelName,
        });
      })
    );
    
    listenerRemoversRef.current.push(
      livekitManager.addParticipantDisconnectedListener((channelName, participant) => {
        useDispatchStore.getState().addEvent({
          type: 'unit_left',
          unit: participant.identity,
          channel: channelName,
        });
      })
    );
    
    listenerRemoversRef.current.push(
      livekitManager.addDataReceivedListener((channelName, message, participant) => {
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
      console.log('[LiveKitConnection] Emergency via ' + source + ':', data);
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
      console.log('[LiveKitConnection] Emergency END via signaling:', data);
      const store = useDispatchStore.getState();
      const matches = store.emergencies.filter(e =>
        e.unitIdentity === data.unitId
      );
      matches.forEach(match => store.removeEmergency(match.id));
    });
    listenerRemoversRef.current.push(removeSignalingEmergencyEnd);

    const removeSignalingPttStart = signalingManager.on('pttStart', (data) => {
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
      livekitManager.addConnectionStateChangeListener((channelName, state, error) => {
        console.log(`[LiveKitConnection] ${channelName} state: ${state}`);
        
        if (mountedRef.current) {
          setConnectionHealth(livekitManager.getConnectionStatus());
        }
        
        if (state === 'disconnected' && mountedRef.current && !livekitManager.isDispatcherMode()) {
          scheduleReconnect(channelName, identity);
        }
      })
    );
    
    listenerRemoversRef.current.push(
      livekitManager.addHealthChangeListener((channelName, health) => {
        console.log(`[LiveKitConnection] Health change for ${channelName}:`, health);
        if (mountedRef.current) {
          setConnectionHealth(livekitManager.getConnectionStatus());
        }
      })
    );
  }, [scheduleReconnect, recordActivity]);

  const preCaptureForMobile = useCallback(async () => {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    
    if (!isMobile) return;
    
    if (micStreamRef.current) {
      console.log('[LiveKitConnection] Mobile mic already captured');
      return;
    }
    
    try {
      console.log('[LiveKitConnection] Mobile detected - pre-capturing mic for RX audio');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      console.log('[LiveKitConnection] Mobile mic pre-capture successful');
    } catch (err) {
      console.warn('[LiveKitConnection] Mobile mic pre-capture failed:', err.message);
    }
  }, []);

  const releaseMobileMic = useCallback(() => {
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
      console.log('[LiveKitConnection] Mobile mic released');
    }
  }, []);

  const connectToChannel = useCallback(async (channelName, identity, markActive = true) => {
    if (!channelName || !identity) return false;
    
    recordActivity();
    
    try {
      const tConnect = performance.now();
      await Promise.all([
        preCaptureForMobile(),
        livekitManager.connect(channelName, identity)
      ]);
      console.log(`[LiveKitConnection] connectToChannel total for ${channelName}: ${(performance.now() - tConnect).toFixed(1)}ms`);
      connectionStartTimes.current.set(channelName, Date.now());
      
      if (markActive) {
        livekitManager.setChannelActive(channelName);
      }
      
      console.log(`[LiveKitConnection] Connected to ${channelName}`);
      return true;
    } catch (err) {
      console.error(`[LiveKitConnection] Failed to connect to ${channelName}:`, err);
      if (!livekitManager.isDispatcherMode()) {
        scheduleReconnect(channelName, identity);
      }
      return false;
    }
  }, [recordActivity, preCaptureForMobile, scheduleReconnect]);

  const disconnectFromChannel = useCallback(async (channelName) => {
    clearReconnectTimer(channelName);
    livekitManager.setChannelInactive(channelName);
    await livekitManager.disconnect(channelName);
    console.log(`[LiveKitConnection] Disconnected from ${channelName}`);
  }, [clearReconnectTimer]);

  const switchChannel = useCallback(async (newChannelName, callerIdentity, isDispatcher = false) => {
    const resolvedIdentity = callerIdentity || identity;
    if (!newChannelName || !resolvedIdentity) {
      console.warn('[LiveKitConnection] switchChannel called without channelName or identity', { newChannelName, resolvedIdentity });
      return;
    }
    
    recordActivity();
    
    const currentPath = location.pathname;
    const isDispatcherRoute = currentPath === '/dispatcher';
    
    if (isDispatcherRoute || isDispatcher) {
      await connectToChannel(newChannelName, resolvedIdentity);
      return;
    }
    
    const currentChannels = livekitManager.getConnectedChannels();
    const channelsToKeep = scanMode 
      ? [newChannelName, ...scanChannels.filter(ch => ch !== newChannelName)]
      : [newChannelName];
    
    for (const ch of currentChannels) {
      if (!channelsToKeep.includes(ch)) {
        await disconnectFromChannel(ch);
      }
    }
    
    if (!currentChannels.includes(newChannelName)) {
      await connectToChannel(newChannelName, resolvedIdentity);
    }
    
    setActiveChannel(newChannelName);
    setConnectionHealth(livekitManager.getConnectionStatus());
    
    const connectedCount = livekitManager.getConnectedChannels().length;
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
    
    const currentChannels = livekitManager.getConnectedChannels();
    const channelsToKeep = enabled 
      ? [activeChannel, ...newScanChannels].filter(Boolean)
      : [activeChannel].filter(Boolean);
    
    for (const ch of currentChannels) {
      if (!channelsToKeep.includes(ch)) {
        console.log(`[LiveKitConnection] Disconnecting from ${ch} (not in keep list)`);
        await disconnectFromChannel(ch);
      }
    }
    
    if (enabled && newScanChannels.length > 0) {
      console.log(`[LiveKitConnection] Scan mode ON - connecting to ${newScanChannels.length} channels`);
      for (const ch of newScanChannels) {
        if (!livekitManager.isConnected(ch)) {
          await connectToChannel(ch, identity);
        }
      }
    }
    
    setConnectionHealth(livekitManager.getConnectionStatus());
  }, [recordActivity, connectToChannel, disconnectFromChannel, activeChannel]);

  const initializeConnections = useCallback(async (identity, channelsData, initialChannel = null) => {
    if (initializingRef.current) {
      console.log('[LiveKitConnection] Already initializing, skipping');
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
        console.log('[LiveKitConnection] No enabled channels available');
        setConnected(false);
        setConnectionStatus('idle');
        return;
      }
      
      const currentPath = location.pathname;
      const isDispatcher = currentPath === '/dispatcher';
      
      if (isDispatcher) {
        console.log(`[LiveKitConnection] Dispatcher mode - connecting to all ${enabledChannels.length} channels`);

        const connectResults = await Promise.all(
          enabledChannels.map(ch => {
            const roomKey = ch.room_key || ((ch.zone || 'Default') + '__' + ch.name);
            return connectToChannel(roomKey, identity, true).then(success => {
              if (!success) {
                livekitManager.scheduleDispatcherReconnect(roomKey, identity);
              }
              return success;
            }).catch(err => {
              console.warn(`[LiveKitConnection] Dispatcher: failed to connect ${roomKey}:`, err.message);
              livekitManager.scheduleDispatcherReconnect(roomKey, identity);
              return false;
            });
          })
        );

        const successCount = connectResults.filter(Boolean).length;
        if (successCount > 0) {
          setConnected(true);
          setConnectionStatus(successCount === enabledChannels.length ? 'connected' : 'partial');
        } else {
          setConnected(false);
          setConnectionStatus('failed');
        }
        console.log(`[LiveKitConnection] Dispatcher mode - connected ${successCount}/${enabledChannels.length} channels`);
      } else {
        const firstChannel = initialChannel || enabledChannels[0]?.room_key || enabledChannels[0]?.name;
        if (firstChannel) {
          console.log(`[LiveKitConnection] Radio mode - setting active channel to ${firstChannel}`);
          setActiveChannel(firstChannel);
          setConnected(true);
          setConnectionStatus('connected');
          
          const success = await connectToChannel(firstChannel, identity);
          if (!success) {
            console.warn(`[LiveKitConnection] Initial LiveKit connect to ${firstChannel} failed - will retry on transmit`);
          }
        }
      }
      
      setConnectionHealth(livekitManager.getConnectionStatus());
      
    } catch (err) {
      console.error('[LiveKitConnection] Initialization failed:', err);
      setConnectionError(err.message || 'Connection failed');
      setConnectionStatus('failed');
    } finally {
      initializingRef.current = false;
      setConnecting(false);
    }
  }, [setupEventHandlers, setConnected, setConnecting, setConnectionError, connectToChannel, location.pathname]);

  const disconnectAll = useCallback(async () => {
    console.log('[LiveKitConnection] Disconnecting all');
    livekitManager.setDispatcherMode(false);
    onDemandVoiceManager.setDispatcherMode(false);
    clearAllReconnectTimers();
    releaseMobileMic();
    await livekitManager.disconnectAll();
    setConnected(false);
    setConnectionStatus('idle');
    setActiveChannel(null);
    initializingRef.current = false;
    lastUserRef.current = null;
  }, [clearAllReconnectTimers, setConnected, releaseMobileMic]);

  const retryConnection = useCallback(async () => {
    if (!user) return;
    
    console.log('[LiveKitConnection] Retrying connection...');
    recordActivity();
    clearAllReconnectTimers();
    initializingRef.current = false;
    lastUserRef.current = null;
    await livekitManager.disconnectAll();
    
    try {
      const data = await getChannels();
      const fetchedChannels = data.channels || [];
      setChannels(fetchedChannels);
      lastUserRef.current = identity;
      await initializeConnections(identity, fetchedChannels);
    } catch (err) {
      console.error('[LiveKitConnection] Retry failed:', err);
      setConnectionError(err.message);
      lastUserRef.current = null;
    }
  }, [user, recordActivity, clearAllReconnectTimers, setChannels, initializeConnections, setConnectionError]);

  const ensureConnected = useCallback(async (channelName) => {
    if (!user) return false;
    
    recordActivity();
    
    if (livekitManager.isConnected(channelName)) {
      return true;
    }
    
    console.log(`[LiveKitConnection] Reconnecting to ${channelName} after idle...`);
    return await connectToChannel(channelName, identity);
  }, [identity, recordActivity, connectToChannel]);

  useEffect(() => {
    if (idleTimerRef.current) {
      clearInterval(idleTimerRef.current);
    }
    
    const currentPath = location.pathname;
    const isDispatcher = currentPath === '/dispatcher';
    const isRadio = currentPath === '/';
    
    livekitManager.setDispatcherMode(isDispatcher);
    onDemandVoiceManager.setDispatcherMode(isDispatcher);

    if (isDispatcher || isRadio) {
      console.log(`[LiveKitConnection] ${isDispatcher ? 'Dispatcher' : 'Radio'} mode - idle timeout disabled (must survive screen lock)`);
      return;
    }
    
    idleTimerRef.current = setInterval(() => {
      const idleTime = Date.now() - lastActivityRef.current;
      
      if (idleTime >= IDLE_TIMEOUT) {
        console.log(`[LiveKitConnection] Idle for ${Math.round(idleTime / 1000)}s - disconnecting to save costs`);
        
        const connectedChannels = livekitManager.getConnectedChannels();
        connectedChannels.forEach(ch => {
          livekitManager.disconnect(ch);
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
        console.log('[LiveKitConnection] Page became visible — checking audio channels');
        lastActivityRef.current = Date.now();

        const connectedChannels = livekitManager.getConnectedChannels();
        let reconnectedCount = 0;

        for (const channelName of connectedChannels) {
          const conn = livekitManager.getRoom(channelName);
          if (conn && conn.ws && conn.ws.readyState === WebSocket.OPEN) {
            continue;
          }
          const unitId = (conn && conn.unitId) || identity;
          console.log(`[LiveKitConnection] Audio WS dead for ${channelName} after visibility restore — reconnecting`);
          livekitManager.disconnect(channelName).then(() => {
            connectToChannel(channelName, unitId);
          });
          reconnectedCount++;
        }

        if (reconnectedCount === 0 && connectedChannels.length === 0 && connectionStatus !== 'idle') {
          console.log('[LiveKitConnection] No audio channels connected after visibility restore — retrying');
          retryConnection();
        } else if (reconnectedCount === 0) {
          console.log('[LiveKitConnection] All audio channels healthy after visibility restore');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, identity, connectionStatus, connectToChannel, retryConnection]);

  useEffect(() => {
    mountedRef.current = true;
    const currentPath = location.pathname;
    
    const init = async () => {
      console.log('[LiveKitConnection] Init check - user:', user?.username, 'lastUser:', lastUserRef.current, 'initializing:', initializingRef.current, 'path:', currentPath);
      
      const shouldConnect = currentPath === '/' || currentPath === '/dispatcher';
      if (!shouldConnect) {
        console.log('[LiveKitConnection] Not on radio or dispatcher route, skipping auto-connect');
        return;
      }
      
      if (!user) {
        console.log('[LiveKitConnection] No user, skipping init');
        return;
      }
      
      if (initializingRef.current) {
        console.log('[LiveKitConnection] Already initializing, skipping');
        return;
      }
      
      if (lastUserRef.current === identity && lastPathRef.current === currentPath) {
        console.log('[LiveKitConnection] Already initialized for this user on this path, skipping');
        return;
      }
      
      lastUserRef.current = identity;
      lastPathRef.current = currentPath;
      
      try {
        console.log('[LiveKitConnection] Fetching channels...');
        const data = await getChannels();
        const fetchedChannels = data.channels || [];
        console.log('[LiveKitConnection] Fetched', fetchedChannels.length, 'channels');
        setChannels(fetchedChannels);

        livekitManager.prepareConnection();
        onDemandVoiceManager.warmUp();
        
        if (fetchedChannels.length > 0) {
          await initializeConnections(identity, fetchedChannels);
        } else {
          console.log('[LiveKitConnection] No channels to connect to');
          setConnected(false);
          setConnectionStatus('idle');
        }
      } catch (err) {
        console.error('[LiveKitConnection] Failed to fetch channels:', err);
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
    livekitManager,
    channels: storeChannels,
    switchChannel,
    toggleScanMode,
    ensureConnected,
    recordActivity,
    connectToChannel,
    disconnectFromChannel,
  };

  return (
    <LiveKitConnectionContext.Provider value={value}>
      {children}
    </LiveKitConnectionContext.Provider>
  );
}

export function useLiveKitConnection() {
  const context = useContext(LiveKitConnectionContext);
  if (!context) {
    throw new Error('useLiveKitConnection must be used within LiveKitConnectionProvider');
  }
  return context;
}

export default LiveKitConnectionContext;
