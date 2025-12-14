import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { livekitManager } from '../audio/LiveKitManager.js';
import { getChannels } from '../utils/api.js';
import useDispatchStore from '../state/dispatchStore.js';

const LiveKitConnectionContext = createContext(null);

// Reconnection with stability detection to prevent infinite loops
const RECONNECT_BASE_DELAY = 2000; // Start at 2 seconds
const RECONNECT_MAX_DELAY = 30000; // Cap at 30s
const RECONNECT_MAX_ATTEMPTS = 10; // Fewer attempts with longer delays
const STABILITY_THRESHOLD = 5000; // Connection must stay stable for 5s before resetting attempts

export function LiveKitConnectionProvider({ children, user }) {
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [connectionHealth, setConnectionHealth] = useState({ status: 'disconnected', healthy: 0, total: 0 });
  const reconnectAttempts = useRef(new Map());
  const reconnectTimers = useRef(new Map());
  const connectionStartTimes = useRef(new Map()); // Track when connections started
  const mountedRef = useRef(true);
  const initializingRef = useRef(false);
  const lastUserRef = useRef(null);
  
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

  const scheduleReconnect = useCallback((channelName, identity) => {
    if (!mountedRef.current) return;
    
    // Check if the last connection was stable (lasted > STABILITY_THRESHOLD)
    const startTime = connectionStartTimes.current.get(channelName);
    const wasStable = startTime && (Date.now() - startTime) > STABILITY_THRESHOLD;
    
    // Only reset attempts if the connection was stable, and clear start time so this only triggers once
    if (wasStable) {
      reconnectAttempts.current.delete(channelName);
      connectionStartTimes.current.delete(channelName); // Clear so next failures increment properly
      console.log(`[LiveKitConnection] Connection to ${channelName} was stable, resetting attempts`);
    }
    
    const attempts = reconnectAttempts.current.get(channelName) || 0;
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      console.log(`[LiveKitConnection] Max reconnect attempts reached for ${channelName}`);
      return;
    }
    
    // Exponential backoff with jitter to prevent thundering herd
    const baseDelay = RECONNECT_BASE_DELAY * Math.pow(2, attempts);
    const jitter = Math.random() * 1000; // 0-1 second jitter
    const delay = Math.min(baseDelay + jitter, RECONNECT_MAX_DELAY);
    
    console.log(`[LiveKitConnection] Scheduling reconnect for ${channelName} in ${Math.round(delay)}ms (attempt ${attempts + 1})`);
    
    clearReconnectTimer(channelName);
    
    const timer = setTimeout(async () => {
      if (!mountedRef.current) return;
      
      reconnectAttempts.current.set(channelName, attempts + 1);
      
      try {
        await livekitManager.connect(channelName, identity);
        connectionStartTimes.current.set(channelName, Date.now());
        console.log(`[LiveKitConnection] Reconnected to ${channelName}`);
        // Don't clear attempts here - let stability detection handle it
      } catch (err) {
        console.error(`[LiveKitConnection] Reconnect failed for ${channelName}:`, err);
        scheduleReconnect(channelName, identity);
      }
    }, delay);
    
    reconnectTimers.current.set(channelName, timer);
  }, [clearReconnectTimer]);

  const setupEventHandlers = useCallback((identity) => {
    livekitManager.onLevelUpdate = (channelName, level) => {
      const channels = useDispatchStore.getState().channels;
      const channel = channels.find(c => c.name === channelName);
      if (channel) {
        useDispatchStore.getState().setChannelLevel(channel.id, level);
      }
    };
    
    livekitManager.onTrackSubscribed = (channelName, track, participant) => {
      const state = useDispatchStore.getState();
      const channel = state.channels.find(c => c.name === channelName);
      if (channel) {
        state.setActiveTransmission(channel.id, {
          from: participant.identity,
          timestamp: Date.now(),
        });
      }
      state.addEvent({
        type: 'ptt_start',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onTrackUnsubscribed = (channelName, track, participant) => {
      const state = useDispatchStore.getState();
      const channel = state.channels.find(c => c.name === channelName);
      if (channel) {
        state.clearActiveTransmission(channel.id);
      }
      state.addEvent({
        type: 'ptt_end',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onParticipantConnected = (channelName, participant) => {
      useDispatchStore.getState().addEvent({
        type: 'unit_joined',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onParticipantDisconnected = (channelName, participant) => {
      useDispatchStore.getState().addEvent({
        type: 'unit_left',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onDataReceived = (channelName, message, participant) => {
      if (message.type === 'emergency') {
        if (message.active) {
          useDispatchStore.getState().addEmergency({
            id: `emergency-${participant?.identity || message.identity}-${Date.now()}`,
            unitIdentity: message.identity,
            channel: channelName,
            timestamp: new Date().toISOString(),
          });
        }
      }
    };
    
    livekitManager.onConnectionStateChange = (channelName, state, error) => {
      console.log(`[LiveKitConnection] ${channelName} state: ${state}`);
      
      // Update connection health state for UI
      if (mountedRef.current) {
        setConnectionHealth(livekitManager.getConnectionStatus());
      }
      
      if (state === 'disconnected' && mountedRef.current) {
        scheduleReconnect(channelName, identity);
      }
    };
    
    // Health change handler for more granular updates
    livekitManager.onHealthChange = (channelName, health) => {
      console.log(`[LiveKitConnection] Health change for ${channelName}:`, health);
      if (mountedRef.current) {
        setConnectionHealth(livekitManager.getConnectionStatus());
      }
    };
  }, [scheduleReconnect]);

  const initializeConnections = useCallback(async (identity, channelsToConnect) => {
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
      
      const enabledChannels = channelsToConnect.filter(ch => ch.enabled);
      console.log(`[LiveKitConnection] Connecting to ${enabledChannels.length} channels as ${identity}`);
      
      const results = await Promise.allSettled(
        enabledChannels.map(async (channel) => {
          try {
            await livekitManager.connect(channel.name, identity);
            connectionStartTimes.current.set(channel.name, Date.now());
            console.log(`[LiveKitConnection] Connected to ${channel.name}`);
            return { channel: channel.name, success: true };
          } catch (err) {
            console.error(`[LiveKitConnection] Failed to connect to ${channel.name}:`, err);
            scheduleReconnect(channel.name, identity);
            return { channel: channel.name, success: false, error: err };
          }
        })
      );
      
      const successCount = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
      console.log(`[LiveKitConnection] Connected to ${successCount}/${enabledChannels.length} channels`);
      
      if (successCount > 0) {
        setConnected(true);
        setConnectionStatus('connected');
      } else {
        setConnectionError('Failed to connect to any channels');
        setConnectionStatus('failed');
      }
      
    } catch (err) {
      console.error('[LiveKitConnection] Initialization failed:', err);
      setConnectionError(err.message || 'Connection failed');
      setConnectionStatus('failed');
    } finally {
      initializingRef.current = false;
      setConnecting(false);
    }
  }, [setupEventHandlers, setConnected, setConnecting, setConnectionError, scheduleReconnect]);

  const disconnectAll = useCallback(async () => {
    console.log('[LiveKitConnection] Disconnecting all');
    clearAllReconnectTimers();
    await livekitManager.disconnectAll();
    setConnected(false);
    setConnectionStatus('idle');
    initializingRef.current = false;
    lastUserRef.current = null;
  }, [clearAllReconnectTimers, setConnected]);

  const retryConnection = useCallback(async () => {
    if (!user) return;
    
    console.log('[LiveKitConnection] Retrying connection...');
    clearAllReconnectTimers();
    initializingRef.current = false;
    lastUserRef.current = null;
    await livekitManager.disconnectAll();
    
    try {
      const data = await getChannels();
      const fetchedChannels = data.channels || [];
      setChannels(fetchedChannels);
      lastUserRef.current = user.username;
      await initializeConnections(user.username, fetchedChannels);
    } catch (err) {
      console.error('[LiveKitConnection] Retry failed:', err);
      setConnectionError(err.message);
      lastUserRef.current = null;
    }
  }, [user, clearAllReconnectTimers, setChannels, initializeConnections, setConnectionError]);

  useEffect(() => {
    mountedRef.current = true;
    
    const init = async () => {
      console.log('[LiveKitConnection] Init check - user:', user?.username, 'lastUser:', lastUserRef.current, 'initializing:', initializingRef.current);
      
      if (!user) {
        console.log('[LiveKitConnection] No user, skipping init');
        return;
      }
      
      if (initializingRef.current) {
        console.log('[LiveKitConnection] Already initializing, skipping');
        return;
      }
      
      if (lastUserRef.current === user.username) {
        console.log('[LiveKitConnection] Already initialized for this user, skipping');
        return;
      }
      
      lastUserRef.current = user.username;
      
      try {
        console.log('[LiveKitConnection] Fetching channels...');
        const data = await getChannels();
        const fetchedChannels = data.channels || [];
        console.log('[LiveKitConnection] Fetched', fetchedChannels.length, 'channels');
        setChannels(fetchedChannels);
        
        if (fetchedChannels.length > 0) {
          await initializeConnections(user.username, fetchedChannels);
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
  }, [user, setChannels, initializeConnections, setConnectionError, setConnected]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearAllReconnectTimers();
    };
  }, [clearAllReconnectTimers]);

  const value = {
    connectionStatus,
    connectionHealth,
    disconnectAll,
    retryConnection,
    livekitManager,
    channels: storeChannels,
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
