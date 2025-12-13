import { createContext, useContext, useEffect, useRef, useCallback, useState } from 'react';
import { livekitManager } from '../audio/LiveKitManager.js';
import { getChannels } from '../utils/api.js';
import useDispatchStore from '../state/dispatchStore.js';

const LiveKitConnectionContext = createContext(null);

const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;

export function LiveKitConnectionProvider({ children, user }) {
  const [isInitialized, setIsInitialized] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const reconnectAttempts = useRef(new Map());
  const reconnectTimers = useRef(new Map());
  const mountedRef = useRef(true);
  const initializingRef = useRef(false);
  
  const {
    setChannels,
    setConnected,
    setConnecting,
    setConnectionError,
    setChannelLevel,
    setActiveTransmission,
    clearActiveTransmission,
    addEvent,
    addEmergency,
    channels: storeChannels,
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
  }, [clearReconnectTimer]);

  const scheduleReconnect = useCallback((channelName, identity) => {
    if (!mountedRef.current) return;
    
    const attempts = reconnectAttempts.current.get(channelName) || 0;
    if (attempts >= RECONNECT_MAX_ATTEMPTS) {
      console.log(`[LiveKitConnection] Max reconnect attempts reached for ${channelName}`);
      return;
    }
    
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, attempts),
      RECONNECT_MAX_DELAY
    );
    
    console.log(`[LiveKitConnection] Scheduling reconnect for ${channelName} in ${delay}ms (attempt ${attempts + 1})`);
    
    clearReconnectTimer(channelName);
    
    const timer = setTimeout(async () => {
      if (!mountedRef.current) return;
      
      reconnectAttempts.current.set(channelName, attempts + 1);
      
      try {
        await livekitManager.connect(channelName, identity);
        console.log(`[LiveKitConnection] Reconnected to ${channelName}`);
        reconnectAttempts.current.delete(channelName);
      } catch (err) {
        console.error(`[LiveKitConnection] Reconnect failed for ${channelName}:`, err);
        scheduleReconnect(channelName, identity);
      }
    }, delay);
    
    reconnectTimers.current.set(channelName, timer);
  }, [clearReconnectTimer]);

  const setupEventHandlers = useCallback((identity) => {
    livekitManager.onLevelUpdate = (channelName, level) => {
      const channel = storeChannels.find(c => c.name === channelName);
      if (channel) {
        setChannelLevel(channel.id, level);
      }
    };
    
    livekitManager.onTrackSubscribed = (channelName, track, participant) => {
      const channel = storeChannels.find(c => c.name === channelName);
      if (channel) {
        setActiveTransmission(channel.id, {
          from: participant.identity,
          timestamp: Date.now(),
        });
      }
      addEvent({
        type: 'ptt_start',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onTrackUnsubscribed = (channelName, track, participant) => {
      const channel = storeChannels.find(c => c.name === channelName);
      if (channel) {
        clearActiveTransmission(channel.id);
      }
      addEvent({
        type: 'ptt_end',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onParticipantConnected = (channelName, participant) => {
      addEvent({
        type: 'unit_joined',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onParticipantDisconnected = (channelName, participant) => {
      addEvent({
        type: 'unit_left',
        unit: participant.identity,
        channel: channelName,
      });
    };
    
    livekitManager.onDataReceived = (channelName, message, participant) => {
      if (message.type === 'emergency') {
        if (message.active) {
          addEmergency({
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
      
      if (state === 'disconnected' && mountedRef.current) {
        scheduleReconnect(channelName, identity);
      }
    };
  }, [storeChannels, setChannelLevel, setActiveTransmission, clearActiveTransmission, addEvent, addEmergency, scheduleReconnect]);

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
      
      const enabledChannels = channelsToConnect.filter(ch => ch.is_active);
      console.log(`[LiveKitConnection] Connecting to ${enabledChannels.length} channels as ${identity}`);
      
      const results = await Promise.allSettled(
        enabledChannels.map(async (channel) => {
          try {
            await livekitManager.connect(channel.name, identity);
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
      
      setIsInitialized(true);
      
    } catch (err) {
      console.error('[LiveKitConnection] Initialization failed:', err);
      setConnectionError(err.message);
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
    setIsInitialized(false);
    setConnectionStatus('idle');
  }, [clearAllReconnectTimers, setConnected]);

  const retryConnection = useCallback(async () => {
    if (!user) return;
    
    clearAllReconnectTimers();
    await livekitManager.disconnectAll();
    
    try {
      const data = await getChannels();
      const fetchedChannels = data.channels || [];
      setChannels(fetchedChannels);
      await initializeConnections(user.username, fetchedChannels);
    } catch (err) {
      console.error('[LiveKitConnection] Retry failed:', err);
      setConnectionError(err.message);
    }
  }, [user, clearAllReconnectTimers, setChannels, initializeConnections, setConnectionError]);

  useEffect(() => {
    mountedRef.current = true;
    
    const init = async () => {
      if (!user || isInitialized || initializingRef.current) return;
      
      try {
        const data = await getChannels();
        const fetchedChannels = data.channels || [];
        setChannels(fetchedChannels);
        
        if (fetchedChannels.length > 0) {
          await initializeConnections(user.username, fetchedChannels);
        }
      } catch (err) {
        console.error('[LiveKitConnection] Failed to fetch channels:', err);
        setConnectionError(err.message);
      }
    };
    
    init();
    
    return () => {
      mountedRef.current = false;
    };
  }, [user, isInitialized, setChannels, initializeConnections, setConnectionError]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      clearAllReconnectTimers();
    };
  }, [clearAllReconnectTimers]);

  const value = {
    isInitialized,
    connectionStatus,
    disconnectAll,
    retryConnection,
    livekitManager,
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
