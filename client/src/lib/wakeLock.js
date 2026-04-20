import { isIOS } from './platform.js';

let sentinel = null;
let refCount = 0;
let visibilityListenerAttached = false;

function isSupported() {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return false;
  // Scope: this helper exists strictly for the iOS PWA polish task. The
  // project requires Chrome/desktop behavior to be unchanged, so we only
  // engage the screen wake lock on iOS (Safari or installed PWA). Other
  // platforms keep their existing power management untouched.
  return isIOS();
}

async function requestSentinel() {
  if (!isSupported() || sentinel) return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch (e) {
    sentinel = null;
  }
}

async function releaseSentinel() {
  if (!sentinel) return;
  try {
    await sentinel.release();
  } catch (e) {}
  sentinel = null;
}

function ensureVisibilityListener() {
  if (visibilityListenerAttached || typeof document === 'undefined') return;
  visibilityListenerAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && refCount > 0 && !sentinel) {
      requestSentinel();
    }
  });
}

export async function acquireWakeLock() {
  ensureVisibilityListener();
  refCount += 1;
  if (refCount === 1) {
    await requestSentinel();
  }
}

export async function releaseWakeLock() {
  if (refCount === 0) return;
  refCount -= 1;
  if (refCount === 0) {
    await releaseSentinel();
  }
}

export function isWakeLockSupported() {
  return isSupported();
}
