import { useState, useEffect, useRef, useCallback } from 'react';
import { apiClient } from '@/lib/api-client';
import { 
  getSettings, 
  isNative, 
  startLocationTracking as capStartTracking,
  stopLocationTracking as capStopTracking,
  getCurrentPosition as capGetPosition
} from '@/lib/capacitor';

interface LocationState {
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
  error: string | null;
  isTracking: boolean;
  lastUpdate: Date | null;
}

interface UseLocationOptions {
  enableHighAccuracy?: boolean;
  autoStart?: boolean;
}

export function useLocation(options: UseLocationOptions = {}) {
  const {
    enableHighAccuracy = true,
    autoStart = true
  } = options;
  
  const [updateIntervalMs, setUpdateIntervalMs] = useState(30000);
  const [gpsEnabled, setGpsEnabled] = useState(true);

  const [state, setState] = useState<LocationState>({
    latitude: null,
    longitude: null,
    accuracy: null,
    error: null,
    isTracking: false,
    lastUpdate: null
  });

  const watchIdRef = useRef<number | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastSentRef = useRef<{ lat: number; lng: number } | null>(null);
  const latestCoordsRef = useRef<{ lat: number; lng: number } | null>(null);
  const isTrackingRef = useRef(false);
  const currentIntervalRef = useRef(30000);

  const sendLocationToBackend = useCallback(async (lat: number, lng: number) => {
    if (lastSentRef.current?.lat === lat && lastSentRef.current?.lng === lng) {
      return;
    }

    try {
      await apiClient.uploadLocation(lat, lng);
      lastSentRef.current = { lat, lng };
      console.log(`[Location] Sent update: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    } catch (err) {
      console.error('[Location] Failed to send update:', err);
    }
  }, []);

  const handlePositionUpdate = useCallback((position: GeolocationPosition) => {
    const { latitude, longitude, accuracy } = position.coords;
    
    latestCoordsRef.current = { lat: latitude, lng: longitude };
    
    setState(prev => ({
      ...prev,
      latitude,
      longitude,
      accuracy,
      error: null,
      lastUpdate: new Date()
    }));

    sendLocationToBackend(latitude, longitude);
  }, [sendLocationToBackend]);

  const handleCapacitorUpdate = useCallback((coords: { latitude: number; longitude: number }) => {
    latestCoordsRef.current = { lat: coords.latitude, lng: coords.longitude };
    
    setState(prev => ({
      ...prev,
      latitude: coords.latitude,
      longitude: coords.longitude,
      error: null,
      lastUpdate: new Date()
    }));

    sendLocationToBackend(coords.latitude, coords.longitude);
  }, [sendLocationToBackend]);

  const handleError = useCallback((error: GeolocationPositionError) => {
    let errorMessage = 'Unknown location error';
    
    switch (error.code) {
      case error.PERMISSION_DENIED:
        errorMessage = 'Location permission denied';
        break;
      case error.POSITION_UNAVAILABLE:
        errorMessage = 'Location unavailable';
        break;
      case error.TIMEOUT:
        errorMessage = 'Location request timed out';
        break;
    }
    
    console.warn('[Location] Error:', errorMessage);
    setState(prev => ({
      ...prev,
      error: errorMessage
    }));
  }, []);

  const stopTracking = useCallback(async () => {
    if (!isTrackingRef.current) return;
    
    console.log('[Location] Stopping tracking');
    isTrackingRef.current = false;

    if (isNative) {
      try {
        await capStopTracking();
      } catch (err) {
        console.error('[Location] Capacitor stop error:', err);
      }
    } else {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }

    setState(prev => ({ ...prev, isTracking: false }));
  }, []);

  const startTracking = useCallback(async (intervalMs?: number) => {
    if (isTrackingRef.current) {
      await stopTracking();
    }
    
    const interval = intervalMs || currentIntervalRef.current;
    currentIntervalRef.current = interval;
    
    isTrackingRef.current = true;
    setState(prev => ({ ...prev, isTracking: true, error: null }));

    if (isNative) {
      console.log('[Location] Starting native Capacitor tracking, interval:', interval / 1000, 's');
      try {
        const pos = await capGetPosition();
        if (pos) {
          handleCapacitorUpdate(pos);
        }
        await capStartTracking(handleCapacitorUpdate, interval / 1000);
      } catch (err) {
        console.error('[Location] Capacitor start error:', err);
        isTrackingRef.current = false;
        setState(prev => ({ 
          ...prev, 
          isTracking: false, 
          error: 'Failed to start native location tracking' 
        }));
        
        if (navigator.geolocation) {
          console.log('[Location] Falling back to browser geolocation');
          startBrowserTracking(interval);
        }
      }
    } else {
      startBrowserTracking(interval);
    }
  }, [handleCapacitorUpdate, stopTracking]);

  const startBrowserTracking = useCallback((interval: number) => {
    if (!navigator.geolocation) {
      setState(prev => ({
        ...prev,
        error: 'Geolocation not supported'
      }));
      isTrackingRef.current = false;
      return;
    }

    console.log('[Location] Starting browser geolocation tracking, interval:', interval / 1000, 's');

    navigator.geolocation.getCurrentPosition(
      handlePositionUpdate,
      handleError,
      { enableHighAccuracy, timeout: 10000, maximumAge: 0 }
    );

    watchIdRef.current = navigator.geolocation.watchPosition(
      handlePositionUpdate,
      handleError,
      { enableHighAccuracy, timeout: 10000, maximumAge: 0 }
    );

    intervalRef.current = setInterval(() => {
      if (latestCoordsRef.current) {
        sendLocationToBackend(latestCoordsRef.current.lat, latestCoordsRef.current.lng);
      }
    }, interval);
    
    isTrackingRef.current = true;
    setState(prev => ({ ...prev, isTracking: true }));
  }, [handlePositionUpdate, handleError, enableHighAccuracy, sendLocationToBackend]);

  const refreshSettings = useCallback(async () => {
    const settings = await getSettings();
    const newEnabled = settings.backgroundGpsEnabled;
    const newInterval = settings.gpsUpdateFrequency * 1000;
    
    setGpsEnabled(newEnabled);
    setUpdateIntervalMs(newInterval);
    
    if (newEnabled && (!isTrackingRef.current || newInterval !== currentIntervalRef.current)) {
      console.log('[Location] Settings changed, restarting tracking');
      await startTracking(newInterval);
    } else if (!newEnabled && isTrackingRef.current) {
      console.log('[Location] GPS disabled in settings, stopping');
      await stopTracking();
    }
    
    return settings;
  }, [startTracking, stopTracking]);

  useEffect(() => {
    const initTracking = async () => {
      const settings = await getSettings();
      const newInterval = settings.gpsUpdateFrequency * 1000;
      
      setGpsEnabled(settings.backgroundGpsEnabled);
      setUpdateIntervalMs(newInterval);
      currentIntervalRef.current = newInterval;
      
      if (!settings.backgroundGpsEnabled) {
        console.log('[Location] Background GPS disabled in settings');
        return;
      }
      
      if (autoStart) {
        startTracking(newInterval);
      }
    };
    
    const delayTimer = setTimeout(() => {
      initTracking();
    }, 1500);
    

    const handleSettingsChanged = () => {
      console.log('[Location] Settings changed event received');
      refreshSettings();
    };

    window.addEventListener('settings-changed', handleSettingsChanged);

    return () => {
      clearTimeout(delayTimer);
      window.removeEventListener('settings-changed', handleSettingsChanged);
      stopTracking();
    };
  }, []);

  return {
    ...state,
    startTracking,
    stopTracking,
    refreshSettings
  };
}
