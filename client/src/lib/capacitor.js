export const isNative = typeof window !== 'undefined' && 
  (window.Capacitor?.isNativePlatform?.() || 
   window.navigator?.userAgent?.includes('Capacitor'));

export const platform = isNative ? 'android' : 'web';

const DEFAULT_SETTINGS = {
  pttKeyCode: null,
  pttKeyLabel: 'Screen Button',
  backgroundGpsEnabled: true,
  gpsUpdateFrequency: 30,
  backgroundAudioEnabled: true,
  alertSoundsEnabled: true,
  dndOverrideEnabled: true,
  dndOverrideEmergency: true,
  dndOverrideCadPriority: true,
  dndOverrideOfficerDown: true,
};

export async function getSettings() {
  try {
    const saved = localStorage.getItem('app_settings');
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(settings) {
  try {
    localStorage.setItem('app_settings', JSON.stringify(settings));
    return true;
  } catch (e) {
    console.error('Failed to save settings:', e);
    return false;
  }
}

export async function requestLocationPermissions() {
  if (!navigator.geolocation) {
    return false;
  }
  
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      () => resolve(true),
      () => resolve(false),
      { timeout: 5000 }
    );
  });
}

export async function requestNotificationPermissions() {
  if (!('Notification' in window)) {
    return true;
  }
  
  if (Notification.permission === 'granted') {
    return true;
  }
  
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export async function requestDndOverridePermission() {
  if (!isNative) {
    return true;
  }
  
  try {
    if (window.DndOverridePlugin?.requestPermission) {
      return await window.DndOverridePlugin.requestPermission();
    }
  } catch (e) {
    console.error('DND permission request failed:', e);
  }
  return false;
}

export async function checkDndOverridePermission() {
  if (!isNative) {
    return true;
  }
  
  try {
    if (window.DndOverridePlugin?.checkPermission) {
      const result = await window.DndOverridePlugin.checkPermission();
      return result?.granted === true;
    }
  } catch (e) {
    console.error('DND permission check failed:', e);
  }
  return false;
}

export async function setHardwarePttKeyCode(keyCode) {
  if (!isNative) {
    return true;
  }
  
  try {
    if (window.HardwarePttPlugin?.setKeyCode) {
      await window.HardwarePttPlugin.setKeyCode({ keyCode });
      return true;
    }
  } catch (e) {
    console.error('Failed to set PTT key:', e);
  }
  return false;
}

export async function requestAllPermissions() {
  console.log('[Capacitor] Requesting all permissions...');
  const results = {};

  results.location = await requestLocationPermissions();
  console.log('[Capacitor] Location permission:', results.location);

  results.notifications = await requestNotificationPermissions();
  console.log('[Capacitor] Notification permission:', results.notifications);

  if (isNative) {
    results.dndOverride = await requestDndOverridePermission();
    console.log('[Capacitor] DND override permission:', results.dndOverride);
  }

  console.log('[Capacitor] All permissions requested:', results);
  return results;
}

export function setupAppLifecycle(onResume, onPause) {
  if (!isNative) {
    return () => {};
  }
  
  if (window.Capacitor?.Plugins?.App) {
    const appPlugin = window.Capacitor.Plugins.App;
    const stateHandler = (state) => {
      if (state.isActive) {
        onResume?.();
      } else {
        onPause?.();
      }
    };
    appPlugin.addListener('appStateChange', stateHandler);
    return () => {
      appPlugin.removeAllListeners?.();
    };
  }
  
  return () => {};
}

export function overrideVisibilityAPI() {
  if (!isNative) return;

  try {
    Object.defineProperty(document, 'hidden', {
      get: function() { return false; },
      configurable: true,
    });
    Object.defineProperty(document, 'visibilityState', {
      get: function() { return 'visible'; },
      configurable: true,
    });

    var origDocAddEventListener = document.addEventListener.bind(document);
    document.addEventListener = function(type, listener, options) {
      if (type === 'visibilitychange') {
        return;
      }
      return origDocAddEventListener(type, listener, options);
    };

    var origWinAddEventListener = window.addEventListener.bind(window);
    window.addEventListener = function(type, listener, options) {
      if (type === 'visibilitychange') {
        return;
      }
      return origWinAddEventListener(type, listener, options);
    };

    if (typeof Page !== 'undefined' && Page.prototype) {
      try {
        Object.defineProperty(Page.prototype, 'hidden', {
          get: function() { return false; },
          configurable: true,
        });
      } catch (e) {}
    }

    console.log('[Capacitor] Visibility API overridden - app will always report visible');
  } catch (e) {
    console.warn('[Capacitor] Failed to override visibility API:', e.message);
  }
}
