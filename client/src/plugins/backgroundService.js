const isNative = typeof window !== 'undefined' && 
  window.Capacitor?.isNativePlatform?.() === true;

let BackgroundService = null;
let isServiceActive = false;
let wakeLockHeld = false;
let webWakeLock = null;

if (isNative && window.Capacitor?.registerPlugin) {
  BackgroundService = window.Capacitor.registerPlugin('BackgroundService');
}

export async function startBackgroundService() {
  if (!isNative || !BackgroundService) {
    console.log('[BackgroundService] Web platform - no background service needed');
    return { success: true, platform: 'web' };
  }
  
  if (isServiceActive) return { success: true, alreadyRunning: true };
  
  try {
    const result = await BackgroundService.startService();
    isServiceActive = true;
    console.log('[BackgroundService] Started foreground service');
    return result;
  } catch (error) {
    console.error('[BackgroundService] Failed to start:', error);
    return { success: false, error: error.message };
  }
}

export async function stopBackgroundService() {
  if (!isNative || !BackgroundService) return { success: true, platform: 'web' };
  if (!isServiceActive) return { success: true, alreadyStopped: true };
  
  try {
    if (wakeLockHeld) {
      await releaseWakeLock();
    }
    const result = await BackgroundService.stopService();
    isServiceActive = false;
    console.log('[BackgroundService] Stopped foreground service');
    return result;
  } catch (error) {
    console.error('[BackgroundService] Failed to stop:', error);
    return { success: false, error: error.message };
  }
}

export async function acquireWakeLock() {
  if (!isNative || !BackgroundService) {
    try {
      if ('wakeLock' in navigator && !webWakeLock) {
        webWakeLock = await navigator.wakeLock.request('screen');
        console.log('[BackgroundService] Web wake lock acquired');
        return { success: true, webLock: true };
      }
    } catch (e) {
      console.log('[BackgroundService] Web wake lock not available:', e.message);
    }
    return { success: true, platform: 'web' };
  }
  
  if (wakeLockHeld) return { success: true, alreadyHeld: true };
  
  try {
    const result = await BackgroundService.acquireWakeLock();
    wakeLockHeld = result.held;
    console.log('[BackgroundService] Wake lock acquired');
    return result;
  } catch (error) {
    console.error('[BackgroundService] Failed to acquire wake lock:', error);
    return { success: false, error: error.message };
  }
}

export async function releaseWakeLock() {
  if (!isNative || !BackgroundService) {
    if (webWakeLock) {
      try {
        await webWakeLock.release();
        webWakeLock = null;
        console.log('[BackgroundService] Web wake lock released');
      } catch (e) {
        console.log('[BackgroundService] Web wake lock release failed:', e.message);
      }
    }
    return { success: true, platform: 'web' };
  }
  
  if (!wakeLockHeld) return { success: true, alreadyReleased: true };
  
  try {
    const result = await BackgroundService.releaseWakeLock();
    wakeLockHeld = !result.success;
    console.log('[BackgroundService] Wake lock released');
    return result;
  } catch (error) {
    console.error('[BackgroundService] Failed to release wake lock:', error);
    return { success: false, error: error.message };
  }
}

export async function isServiceRunning() {
  if (!isNative || !BackgroundService) return false;
  
  try {
    const result = await BackgroundService.isServiceRunning();
    return result.running;
  } catch (error) {
    console.error('[BackgroundService] Failed to check status:', error);
    return false;
  }
}

export function getServiceState() {
  return {
    isNative,
    isServiceActive,
    wakeLockHeld
  };
}

export default {
  startBackgroundService,
  stopBackgroundService,
  acquireWakeLock,
  releaseWakeLock,
  isServiceRunning,
  getServiceState
};
