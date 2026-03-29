let isServiceActive = false;
let webWakeLock = null;

export async function startBackgroundService() {
  isServiceActive = true;
  return { success: true, platform: 'web' };
}

export async function stopBackgroundService() {
  if (webWakeLock) {
    try {
      await webWakeLock.release();
    } catch (_) {
      // best-effort release
    }
    webWakeLock = null;
  }
  isServiceActive = false;
  return { success: true, platform: 'web' };
}

export async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !webWakeLock) {
      webWakeLock = await navigator.wakeLock.request('screen');
      return { success: true, webLock: true };
    }
  } catch (_) {
    // Wake Lock API unavailable or denied.
  }
  return { success: true, platform: 'web' };
}

export async function releaseWakeLock() {
  if (webWakeLock) {
    try {
      await webWakeLock.release();
    } catch (_) {
      // best-effort release
    }
    webWakeLock = null;
  }
  return { success: true, platform: 'web' };
}

export async function isServiceRunning() {
  return isServiceActive;
}

export function getServiceState() {
  return {
    isNative: false,
    isServiceActive,
    wakeLockHeld: webWakeLock !== null,
  };
}

export default {
  startBackgroundService,
  stopBackgroundService,
  acquireWakeLock,
  releaseWakeLock,
  isServiceRunning,
  getServiceState,
};
