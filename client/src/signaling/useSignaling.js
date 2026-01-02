import { useEffect, useState, useCallback, useRef } from 'react';
import { signalingManager } from './SignalingManager.js';

export function useSignaling() {
  const [connected, setConnected] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [livekitAvailable, setLivekitAvailable] = useState(true);

  useEffect(() => {
    const removeConnectionListener = signalingManager.on('connectionChange', (data) => {
      setConnected(data.connected);
      if (!data.connected) {
        setAuthenticated(false);
      }
    });

    const removeSystemStatusListener = signalingManager.on('systemStatus', (data) => {
      setLivekitAvailable(data.livekitAvailable !== false);
    });

    setConnected(signalingManager.socket?.connected || false);
    setAuthenticated(signalingManager.authenticated);
    setLivekitAvailable(signalingManager.livekitAvailable);

    return () => {
      removeConnectionListener();
      removeSystemStatusListener();
    };
  }, []);

  const connect = useCallback(async () => {
    try {
      await signalingManager.connect();
      setConnected(true);
      return true;
    } catch (err) {
      console.error('[useSignaling] Connection failed:', err);
      return false;
    }
  }, []);

  const authenticate = useCallback((unitId, username, agencyId, isDispatcher) => {
    const result = signalingManager.authenticate(unitId, username, agencyId, isDispatcher);
    if (result) {
      setAuthenticated(true);
    }
    return result;
  }, []);

  const disconnect = useCallback(() => {
    signalingManager.disconnect();
    setConnected(false);
    setAuthenticated(false);
  }, []);

  return {
    connected,
    authenticated,
    livekitAvailable,
    connect,
    authenticate,
    disconnect,
    joinChannel: signalingManager.joinChannel.bind(signalingManager),
    leaveChannel: signalingManager.leaveChannel.bind(signalingManager),
    signalPttStart: signalingManager.signalPttStart.bind(signalingManager),
    signalPttEnd: signalingManager.signalPttEnd.bind(signalingManager),
    signalEmergencyStart: signalingManager.signalEmergencyStart.bind(signalingManager),
    signalEmergencyEnd: signalingManager.signalEmergencyEnd.bind(signalingManager),
    updateStatus: signalingManager.updateStatus.bind(signalingManager),
    updateLocation: signalingManager.updateLocation.bind(signalingManager),
    getChannelMembers: signalingManager.getChannelMembers.bind(signalingManager),
    on: signalingManager.on.bind(signalingManager),
    off: signalingManager.off.bind(signalingManager),
  };
}

export function useChannelPresence(channelId) {
  const [members, setMembers] = useState([]);
  const [activeTransmission, setActiveTransmission] = useState(null);
  const [isEmergency, setIsEmergency] = useState(false);

  useEffect(() => {
    if (!channelId) return;

    const removeMembersListener = signalingManager.on('channelMembers', (data) => {
      if (data.channelId === channelId) {
        setMembers(data.members);
      }
    });

    const removeJoinListener = signalingManager.on('channelJoin', (data) => {
      if (data.channelId === channelId) {
        setMembers(prev => {
          const existing = prev.find(m => m.unitId === data.unitId);
          if (existing) return prev;
          return [...prev, { 
            unitId: data.unitId, 
            status: 'online', 
            isDispatcher: data.isDispatcher 
          }];
        });
      }
    });

    const removeLeaveListener = signalingManager.on('channelLeave', (data) => {
      if (data.channelId === channelId) {
        setMembers(prev => prev.filter(m => m.unitId !== data.unitId));
      }
    });

    const removePttStartListener = signalingManager.on('pttStart', (data) => {
      if (data.channelId === channelId) {
        setActiveTransmission(data);
        setMembers(prev => prev.map(m => 
          m.unitId === data.unitId ? { ...m, status: 'transmitting' } : m
        ));
      }
    });

    const removePttEndListener = signalingManager.on('pttEnd', (data) => {
      if (data.channelId === channelId) {
        setActiveTransmission(null);
        setMembers(prev => prev.map(m => 
          m.unitId === data.unitId ? { ...m, status: 'online' } : m
        ));
      }
    });

    const removeEmergencyStartListener = signalingManager.on('emergencyStart', (data) => {
      if (data.channelId === channelId) {
        setIsEmergency(true);
        setMembers(prev => prev.map(m => 
          m.unitId === data.unitId ? { ...m, status: 'emergency' } : m
        ));
      }
    });

    const removeEmergencyEndListener = signalingManager.on('emergencyEnd', (data) => {
      if (data.channelId === channelId) {
        setIsEmergency(false);
      }
    });

    const removeStatusListener = signalingManager.on('unitStatus', (data) => {
      if (data.channelId === channelId) {
        setMembers(prev => prev.map(m => 
          m.unitId === data.unitId ? { ...m, status: data.status } : m
        ));
      }
    });

    setMembers(signalingManager.getChannelMembers(channelId));

    return () => {
      removeMembersListener();
      removeJoinListener();
      removeLeaveListener();
      removePttStartListener();
      removePttEndListener();
      removeEmergencyStartListener();
      removeEmergencyEndListener();
      removeStatusListener();
    };
  }, [channelId]);

  return {
    members,
    activeTransmission,
    isEmergency,
    transmittingUnit: activeTransmission?.unitId || null,
  };
}

export function usePttSignaling(channelId) {
  const [isBusy, setIsBusy] = useState(false);
  const [busyUnit, setBusyUnit] = useState(null);

  useEffect(() => {
    const removeBusyListener = signalingManager.on('pttBusy', (data) => {
      if (data.channelId === channelId) {
        setIsBusy(true);
        setBusyUnit(data.transmittingUnit);
        setTimeout(() => {
          setIsBusy(false);
          setBusyUnit(null);
        }, 2000);
      }
    });

    return () => removeBusyListener();
  }, [channelId]);

  const startPtt = useCallback(() => {
    return signalingManager.signalPttStart(channelId);
  }, [channelId]);

  const endPtt = useCallback(() => {
    return signalingManager.signalPttEnd(channelId);
  }, [channelId]);

  return {
    startPtt,
    endPtt,
    isBusy,
    busyUnit,
  };
}

export function useEmergencySignaling() {
  const [emergencyChannels, setEmergencyChannels] = useState(new Set());
  const [emergencyAlerts, setEmergencyAlerts] = useState([]);

  useEffect(() => {
    const removeStartListener = signalingManager.on('emergencyStart', (data) => {
      setEmergencyChannels(prev => new Set([...prev, data.channelId]));
    });

    const removeEndListener = signalingManager.on('emergencyEnd', (data) => {
      setEmergencyChannels(prev => {
        const next = new Set(prev);
        next.delete(data.channelId);
        return next;
      });
    });

    const removeAlertListener = signalingManager.on('emergencyAlert', (data) => {
      setEmergencyAlerts(prev => [...prev, data]);
    });

    return () => {
      removeStartListener();
      removeEndListener();
      removeAlertListener();
    };
  }, []);

  const startEmergency = useCallback((channelId) => {
    return signalingManager.signalEmergencyStart(channelId);
  }, []);

  const endEmergency = useCallback((channelId) => {
    return signalingManager.signalEmergencyEnd(channelId);
  }, []);

  const clearAlert = useCallback((index) => {
    setEmergencyAlerts(prev => prev.filter((_, i) => i !== index));
  }, []);

  return {
    emergencyChannels: Array.from(emergencyChannels),
    emergencyAlerts,
    startEmergency,
    endEmergency,
    clearAlert,
    isEmergencyActive: (channelId) => emergencyChannels.has(channelId),
  };
}

export function useLocationSignaling(enabled = true, intervalMs = 30000) {
  const intervalRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    const updateLocation = () => {
      if (!navigator.geolocation) return;
      
      navigator.geolocation.getCurrentPosition(
        (position) => {
          signalingManager.updateLocation(
            position.coords.latitude,
            position.coords.longitude,
            position.coords.accuracy,
            position.coords.heading,
            position.coords.speed
          );
        },
        (error) => {
          console.warn('[useLocationSignaling] Geolocation error:', error.message);
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    };

    updateLocation();
    intervalRef.current = setInterval(updateLocation, intervalMs);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [enabled, intervalMs]);
}
