import { useState, useEffect, useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function getServerSnapshot() {
  return false;
}

function subscribe(callback) {
  window.addEventListener('resize', callback);
  return () => window.removeEventListener('resize', callback);
}

export function useMobile() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useIsCapacitor() {
  const [isCapacitor, setIsCapacitor] = useState(false);

  useEffect(() => {
    setIsCapacitor(
      typeof window !== 'undefined' && 
      (window.Capacitor?.isNativePlatform?.() || 
       window.navigator?.userAgent?.includes('Capacitor'))
    );
  }, []);

  return isCapacitor;
}
