export function isIOS() {
  if (typeof window === 'undefined' || !window.navigator) return false;
  const ua = window.navigator.userAgent || '';
  const platform = window.navigator.platform || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  if (platform === 'MacIntel' && (window.navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

export function isStandalonePWA() {
  if (typeof window === 'undefined') return false;
  if (window.navigator?.standalone === true) return true;
  if (typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(display-mode: standalone)').matches;
    } catch {
      return false;
    }
  }
  return false;
}

export function isIOSSafari() {
  if (!isIOS()) return false;
  const ua = window.navigator.userAgent || '';
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}
