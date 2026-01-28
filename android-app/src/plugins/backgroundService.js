import { registerPlugin } from '@capacitor/core';

const BackgroundService = registerPlugin('BackgroundService');

let isServiceActive = false;
let wakeLockHeld = false;

export async function startBackgroundService() {
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
