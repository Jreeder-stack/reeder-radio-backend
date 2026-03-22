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

export async function syncSettingsToNative(settings) {
  try {
    await BackgroundService.syncSettingsToNative({ settings: JSON.stringify(settings) });
    console.log('[BackgroundService] Settings synced to native SharedPreferences');
    return { success: true };
  } catch (error) {
    console.error('[BackgroundService] Failed to sync settings:', error);
    return { success: false, error: error.message };
  }
}

export async function checkBatteryOptimization() {
  try {
    const result = await BackgroundService.checkBatteryOptimization();
    return result.isExempt;
  } catch (error) {
    console.error('[BackgroundService] Failed to check battery optimization:', error);
    return false;
  }
}

export async function requestBatteryOptimizationExemption() {
  try {
    const result = await BackgroundService.requestBatteryOptimizationExemption();
    return result.success;
  } catch (error) {
    console.error('[BackgroundService] Failed to request battery optimization exemption:', error);
    return false;
  }
}

export async function getSharedPreference(key, defaultValue = '') {
  try {
    const result = await BackgroundService.getSharedPreference({ key, defaultValue });
    return result.value;
  } catch (error) {
    console.error('[BackgroundService] Failed to get preference:', error);
    return defaultValue;
  }
}

export async function setSharedPreference(key, value) {
  try {
    await BackgroundService.setSharedPreference({ key, value });
    return true;
  } catch (error) {
    console.error('[BackgroundService] Failed to set preference:', error);
    return false;
  }
}

export default {
  startBackgroundService,
  stopBackgroundService,
  acquireWakeLock,
  releaseWakeLock,
  isServiceRunning,
  getServiceState,
  syncSettingsToNative,
  checkBatteryOptimization,
  requestBatteryOptimizationExemption,
  getSharedPreference,
  setSharedPreference
};
