import { signalingManager } from '../signaling/SignalingManager.js';

let watchId = null;
let lastEmitTime = 0;
const MIN_EMIT_INTERVAL = 5000;

function startTracking() {
  if (watchId !== null) {
    return;
  }

  if (!navigator.geolocation) {
    console.warn('[GPS] Geolocation not supported');
    return;
  }

  console.log('[GPS] Starting tracking');

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      const now = Date.now();
      if (now - lastEmitTime < MIN_EMIT_INTERVAL) {
        return;
      }
      lastEmitTime = now;

      const locationData = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
        heading: position.coords.heading,
        speed: position.coords.speed,
        timestamp: now,
      };

      if (signalingManager.socket?.connected) {
        signalingManager.socket.emit('location:update', locationData);
      }
    },
    (err) => {
      console.warn('[GPS] Position error:', err.message);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 3000,
    }
  );
}

function stopTracking() {
  if (watchId !== null) {
    console.log('[GPS] Stopping tracking');
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    lastEmitTime = 0;
  }
}

function isTracking() {
  return watchId !== null;
}

export { startTracking, stopTracking, isTracking };
