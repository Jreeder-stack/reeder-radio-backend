import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { signalingManager } from '../signaling/SignalingManager.js';
import { useAuth } from '../AuthContext.jsx';
import { micPTTManager } from '../audio/MicPTTManager.js';
import useDispatchStore from '../state/dispatchStore.js';

micPTTManager.setSignalingManager(signalingManager);

const SignalingContext = createContext(null);

export function SignalingProvider({ children }) {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [channelMembers, setChannelMembers] = useState({});
  const [activeTransmissions, setActiveTransmissions] = useState({});
  const [emergencyChannels, setEmergencyChannels] = useState(new Set());
  const [emergencyAlerts, setEmergencyAlerts] = useState([]);
  const [unitLocations, setUnitLocations] = useState({});
  const [trackedUnits, setTrackedUnits] = useState(new Set());
  const locationIntervalRef = useRef(null);
  const joinedChannelsRef = useRef(new Set());

  useEffect(() => {
    if (!user) {
      if (signalingManager.socket?.connected) {
        signalingManager.disconnect();
      }
      setConnected(false);
      setAuthenticated(false);
      return;
    }

    const connectAndAuth = async () => {
      try {
        await signalingManager.connect();
        setConnected(true);
        
        const unitId = user.unit_id || user.username;
        await signalingManager.authenticate(
          unitId,
          user.username,
          'default',
          user.is_dispatcher || user.role === 'admin'
        );
        setAuthenticated(true);
        
        console.log('[SignalingContext] Connected and authenticated as', unitId);
      } catch (err) {
        console.error('[SignalingContext] Connection failed:', err);
        setConnected(false);
        setAuthenticated(false);
      }
    };

    connectAndAuth();

    const removeConnectionListener = signalingManager.on('connectionChange', (data) => {
      setConnected(data.connected);
      if (!data.connected) {
        setAuthenticated(false);
      }
    });

    const onSocketAuthenticated = () => {
      setAuthenticated(true);
    };
    const registerAuthListener = () => {
      if (signalingManager.socket) {
        signalingManager.socket.off('authenticated', onSocketAuthenticated);
        signalingManager.socket.on('authenticated', onSocketAuthenticated);
      }
    };
    registerAuthListener();
    const removeReconnectAuthListener = signalingManager.on('connectionChange', (data) => {
      if (data.connected) {
        registerAuthListener();
      }
    });

    const removeMembersListener = signalingManager.on('channelMembers', (data) => {
      setChannelMembers(prev => ({
        ...prev,
        [data.channelId]: data.members,
      }));
    });

    const removeJoinListener = signalingManager.on('channelJoin', (data) => {
      setChannelMembers(prev => {
        const existing = prev[data.channelId] || [];
        if (existing.find(m => m.unitId === data.unitId)) return prev;
        return {
          ...prev,
          [data.channelId]: [...existing, {
            unitId: data.unitId,
            status: 'online',
            isDispatcher: data.isDispatcher,
          }],
        };
      });
    });

    const removeLeaveListener = signalingManager.on('channelLeave', (data) => {
      setChannelMembers(prev => ({
        ...prev,
        [data.channelId]: (prev[data.channelId] || []).filter(m => m.unitId !== data.unitId),
      }));
    });

    const localIdentity = user?.unit_id || user?.username;
    const removePttStartListener = signalingManager.on('pttStart', (data) => {
      if (data.unitId !== localIdentity && data.unitId !== user?.username) {
        setActiveTransmissions(prev => ({
          ...prev,
          [data.channelId]: data,
        }));
      }
      setChannelMembers(prev => ({
        ...prev,
        [data.channelId]: (prev[data.channelId] || []).map(m =>
          m.unitId === data.unitId ? { ...m, status: 'transmitting' } : m
        ),
      }));
    });

    const removePttEndListener = signalingManager.on('pttEnd', (data) => {
      setActiveTransmissions(prev => {
        const next = { ...prev };
        delete next[data.channelId];
        return next;
      });
      setChannelMembers(prev => ({
        ...prev,
        [data.channelId]: (prev[data.channelId] || []).map(m =>
          m.unitId === data.unitId ? { ...m, status: 'online' } : m
        ),
      }));
    });

    const removeEmergencyStartListener = signalingManager.on('emergencyStart', (data) => {
      setEmergencyChannels(prev => new Set([...prev, data.channelId]));
      setEmergencyAlerts(prev => {
        const existing = prev.find(a => a.unitId === data.unitId && a.channelId === data.channelId);
        if (existing) return prev;
        return [...prev, {
          id: 'sig-emerg-' + data.unitId + '-' + Date.now(),
          unitId: data.unitId,
          unitIdentity: data.unitId,
          channelId: data.channelId,
          channel: data.channelId,
          timestamp: new Date().toISOString(),
        }];
      });
      setChannelMembers(prev => ({
        ...prev,
        [data.channelId]: (prev[data.channelId] || []).map(m =>
          m.unitId === data.unitId ? { ...m, status: 'emergency' } : m
        ),
      }));
    });

    const removeEmergencyEndListener = signalingManager.on('emergencyEnd', (data) => {
      setEmergencyChannels(prev => {
        const next = new Set(prev);
        next.delete(data.channelId);
        return next;
      });
      setEmergencyAlerts(prev => prev.filter(a => !(a.unitId === data.unitId && a.channelId === data.channelId)));
      const storeState = useDispatchStore.getState();
      const matchingEmergency = storeState.emergencies.find(
        e => (e.unitIdentity === data.unitId || e.unitId === data.unitId) && (!data.channelId || e.channel === data.channelId)
      );
      if (matchingEmergency) {
        storeState.removeEmergency(matchingEmergency.id);
      }
    });

    const removeAlertListener = signalingManager.on('emergencyAlert', (data) => {
      setEmergencyAlerts(prev => [...prev, data]);
    });

    const removeLocationListener = signalingManager.on('locationUpdate', (data) => {
      setUnitLocations(prev => ({
        ...prev,
        [data.unitId]: {
          latitude: data.latitude,
          longitude: data.longitude,
          accuracy: data.accuracy,
          heading: data.heading,
          speed: data.speed,
          timestamp: data.timestamp,
          channelId: data.channelId,
        },
      }));
    });

    const removeGpsLocationListener = signalingManager.on('location:update', (data) => {
      setUnitLocations(prev => ({
        ...prev,
        [data.unitId]: {
          latitude: data.lat,
          longitude: data.lng,
          accuracy: data.accuracy,
          heading: data.heading,
          speed: data.speed,
          timestamp: data.timestamp,
        },
      }));
      setTrackedUnits(prev => new Set([...prev, data.unitId]));
    });

    const removeStatusListener = signalingManager.on('unitStatus', (data) => {
      setChannelMembers(prev => ({
        ...prev,
        [data.channelId]: (prev[data.channelId] || []).map(m =>
          m.unitId === data.unitId ? { ...m, status: data.status } : m
        ),
      }));
    });

    return () => {
      removeConnectionListener();
      removeReconnectAuthListener();
      if (signalingManager.socket) {
        signalingManager.socket.off('authenticated', onSocketAuthenticated);
      }
      removeMembersListener();
      removeJoinListener();
      removeLeaveListener();
      removePttStartListener();
      removePttEndListener();
      removeEmergencyStartListener();
      removeEmergencyEndListener();
      removeAlertListener();
      removeLocationListener();
      removeGpsLocationListener();
      removeStatusListener();
      
      if (locationIntervalRef.current) {
        clearInterval(locationIntervalRef.current);
      }
    };
  }, [user]);

  const joinChannel = useCallback(async (channelId) => {
    try {
      const result = await signalingManager.joinChannel(channelId);
      if (result) {
        joinedChannelsRef.current.add(channelId);
      }
      return result;
    } catch (err) {
      console.error('[SignalingContext] Failed to join channel:', channelId, err);
      return false;
    }
  }, []);

  const leaveChannel = useCallback((channelId) => {
    const result = signalingManager.leaveChannel(channelId);
    joinedChannelsRef.current.delete(channelId);
    return result;
  }, []);

  const signalPttStart = useCallback((channelId) => {
    return signalingManager.signalPttStart(channelId);
  }, []);

  const signalPttEnd = useCallback((channelId) => {
    return signalingManager.signalPttEnd(channelId);
  }, []);

  const signalEmergencyStart = useCallback((channelId) => {
    return signalingManager.signalEmergencyStart(channelId);
  }, []);

  const signalEmergencyEnd = useCallback((channelId) => {
    return signalingManager.signalEmergencyEnd(channelId);
  }, []);

  const signalClearAirStart = useCallback((channelId) => {
    return signalingManager.signalClearAirStart(channelId);
  }, []);

  const signalClearAirEnd = useCallback((channelId) => {
    return signalingManager.signalClearAirEnd(channelId);
  }, []);

  const updateStatus = useCallback((status) => {
    return signalingManager.updateStatus(status);
  }, []);

  const updateLocation = useCallback((latitude, longitude, accuracy, heading, speed) => {
    return signalingManager.updateLocation(latitude, longitude, accuracy, heading, speed);
  }, []);

  const startLocationTracking = useCallback((intervalMs = 30000) => {
    if (locationIntervalRef.current) {
      clearInterval(locationIntervalRef.current);
    }

    const sendLocation = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          updateLocation(
            pos.coords.latitude,
            pos.coords.longitude,
            pos.coords.accuracy,
            pos.coords.heading,
            pos.coords.speed
          );
        },
        (err) => console.warn('[SignalingContext] Geolocation error:', err.message),
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };

    sendLocation();
    locationIntervalRef.current = setInterval(sendLocation, intervalMs);
  }, [updateLocation]);

  const stopLocationTracking = useCallback(() => {
    if (locationIntervalRef.current) {
      clearInterval(locationIntervalRef.current);
      locationIntervalRef.current = null;
    }
  }, []);

  const emitTrackStart = useCallback((unitId) => {
    if (!signalingManager.socket?.connected) return false;
    signalingManager.socket.emit('location:track_start', { unitId });
    setTrackedUnits(prev => new Set([...prev, unitId]));
    return true;
  }, []);

  const emitTrackStop = useCallback((unitId) => {
    if (!signalingManager.socket?.connected) return false;
    signalingManager.socket.emit('location:track_stop', { unitId });
    setTrackedUnits(prev => {
      const next = new Set(prev);
      next.delete(unitId);
      return next;
    });
    setUnitLocations(prev => {
      const next = { ...prev };
      delete next[unitId];
      return next;
    });
    return true;
  }, []);

  const clearEmergencyAlert = useCallback((index) => {
    setEmergencyAlerts(prev => prev.filter((_, i) => i !== index));
  }, []);

  const getChannelMembers = useCallback((channelId) => {
    return channelMembers[channelId] || [];
  }, [channelMembers]);

  const isTransmitting = useCallback((channelId) => {
    return !!activeTransmissions[channelId];
  }, [activeTransmissions]);

  const getTransmittingUnit = useCallback((channelId) => {
    return activeTransmissions[channelId]?.unitId || null;
  }, [activeTransmissions]);

  const isEmergencyActive = useCallback((channelId) => {
    return emergencyChannels.has(channelId);
  }, [emergencyChannels]);

  const value = {
    connected,
    authenticated,
    channelMembers,
    activeTransmissions,
    emergencyChannels: Array.from(emergencyChannels),
    emergencyAlerts,
    unitLocations,
    trackedUnits: Array.from(trackedUnits),
    joinChannel,
    leaveChannel,
    signalPttStart,
    signalPttEnd,
    signalEmergencyStart,
    signalEmergencyEnd,
    signalClearAirStart,
    signalClearAirEnd,
    updateStatus,
    updateLocation,
    startLocationTracking,
    stopLocationTracking,
    emitTrackStart,
    emitTrackStop,
    clearEmergencyAlert,
    getChannelMembers,
    isTransmitting,
    getTransmittingUnit,
    isEmergencyActive,
  };

  return (
    <SignalingContext.Provider value={value}>
      {children}
    </SignalingContext.Provider>
  );
}

export function useSignalingContext() {
  const context = useContext(SignalingContext);
  if (!context) {
    throw new Error('useSignalingContext must be used within SignalingProvider');
  }
  return context;
}
