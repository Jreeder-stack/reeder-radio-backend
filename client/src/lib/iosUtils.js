export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const isIPhoneOrIPad = /iPad|iPhone|iPod/.test(ua);
  const isIPadOS13Plus =
    navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1;
  return isIPhoneOrIPad || isIPadOS13Plus;
}

export function isSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /^((?!chrome|android|crios|fxios|edgios).)*safari/i.test(ua);
}

export function isStandalonePWA() {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) {
    return true;
  }
  return Boolean(window.navigator && window.navigator.standalone);
}
