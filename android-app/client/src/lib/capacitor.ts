import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { App } from '@capacitor/app';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();

export type MicrophonePermissionStatus = 'granted' | 'denied' | 'prompt' | 'unknown';

export async function checkMicrophonePermission(): Promise<MicrophonePermissionStatus> {
  try {
    if ('permissions' in navigator) {
      const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      console.log('[Capacitor] Microphone permission status:', result.state);
      return result.state as MicrophonePermissionStatus;
    }
    return 'unknown';
  } catch (error) {
    console.error('[Capacitor] Error checking microphone permission:', error);
    return 'unknown';
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  console.log('[Capacitor] Requesting microphone permission...');
  
  // Retry logic for Android permission race condition
  const maxRetries = 3;
  const retryDelay = 500;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[Capacitor] getUserMedia attempt ${attempt}/${maxRetries}`);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('[Capacitor] Microphone permission GRANTED');
      stream.getTracks().forEach(track => track.stop());
      return true;
    } catch (error: any) {
      console.error(`[Capacitor] getUserMedia attempt ${attempt} failed:`, error?.name, error?.message);
      
      // If permission explicitly denied, don't retry
      if (error?.name === 'NotAllowedError' && attempt > 1) {
        console.error('[Capacitor] Microphone permission explicitly DENIED by user');
        return false;
      }
      
      // Wait before retrying (allows Android permission dialog to complete)
      if (attempt < maxRetries) {
        console.log(`[Capacitor] Waiting ${retryDelay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }
  
  console.error('[Capacitor] Microphone permission DENIED after all retries');
  return false;
}

export interface AppSettings {
  backgroundGpsEnabled: boolean;
  gpsUpdateFrequency: number;
  backgroundAudioEnabled: boolean;
  alertSoundsEnabled: boolean;
  pttKeyCode: number | null;
  pttKeyLabel: string;
  dndOverrideEnabled: boolean;
  dndOverrideEmergency: boolean;
  dndOverrideCadPriority: boolean;
  dndOverrideOfficerDown: boolean;
  incomingVolume: number;
  autoIncreaseVolumeEnabled: boolean;
  autoIncreaseVolumeLevel: number;
  playbackAmplifierEnabled: boolean;
  playbackAmplifierLevel: number;
  recordingAmplifierEnabled: boolean;
  recordingAmplifierLevel: number;
  noiseSuppressionEnabled: boolean;
  audioModeOnSendReceiveOnly: boolean;
  volumeButtonPtt: boolean;
  bluetoothMediaButtonPtt: boolean;
  startOnBoot: boolean;
  foregroundOnMessage: 'never' | 'screen_off' | 'always';
  pushNotificationsEnabled: boolean;
  startOnVoiceMessage: boolean;
  workingInBackground: boolean;
  wakeDevice: boolean;
}

const DEFAULT_SETTINGS: AppSettings = {
  backgroundGpsEnabled: true,
  gpsUpdateFrequency: 30,
  backgroundAudioEnabled: true,
  alertSoundsEnabled: true,
  pttKeyCode: null,
  pttKeyLabel: 'Screen Button',
  dndOverrideEnabled: false,
  dndOverrideEmergency: true,
  dndOverrideCadPriority: true,
  dndOverrideOfficerDown: true,
  incomingVolume: 80,
  autoIncreaseVolumeEnabled: false,
  autoIncreaseVolumeLevel: 100,
  playbackAmplifierEnabled: false,
  playbackAmplifierLevel: 50,
  recordingAmplifierEnabled: false,
  recordingAmplifierLevel: 50,
  noiseSuppressionEnabled: false,
  audioModeOnSendReceiveOnly: false,
  volumeButtonPtt: false,
  bluetoothMediaButtonPtt: true,
  startOnBoot: true,
  foregroundOnMessage: 'never',
  pushNotificationsEnabled: true,
  startOnVoiceMessage: false,
  workingInBackground: true,
  wakeDevice: true,
};

export async function getSettings(): Promise<AppSettings> {
  if (!isNative) {
    const stored = localStorage.getItem('app_settings');
    return stored ? { ...DEFAULT_SETTINGS, ...JSON.parse(stored) } : DEFAULT_SETTINGS;
  }
  
  const { value } = await Preferences.get({ key: 'app_settings' });
  return value ? { ...DEFAULT_SETTINGS, ...JSON.parse(value) } : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const data = JSON.stringify(settings);
  
  if (!isNative) {
    localStorage.setItem('app_settings', data);
  } else {
    await Preferences.set({ key: 'app_settings', value: data });
    try {
      const { syncAppSettingsToNative } = await import('./background-service');
      await syncAppSettingsToNative(settings);
    } catch (e) {
      console.warn('[Capacitor] Failed to sync settings to native layer:', e);
    }
  }
  
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: settings }));
}

export async function requestLocationPermissions(): Promise<boolean> {
  if (!isNative) {
    return true;
  }
  
  try {
    const status = await Geolocation.requestPermissions();
    return status.location === 'granted' || status.coarseLocation === 'granted';
  } catch (error) {
    console.error('[Capacitor] Location permission error:', error);
    return false;
  }
}

export async function getCurrentPosition(): Promise<{ latitude: number; longitude: number } | null> {
  try {
    if (!isNative) {
      return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
          (err) => reject(err),
          { enableHighAccuracy: true, timeout: 10000 }
        );
      });
    }
    
    const position = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10000,
    });
    
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    };
  } catch (error) {
    console.error('[Capacitor] Get position error:', error);
    return null;
  }
}

let watchId: string | null = null;

export async function startLocationTracking(
  callback: (coords: { latitude: number; longitude: number }) => void,
  intervalSeconds: number = 30
): Promise<void> {
  if (!isNative) {
    const id = navigator.geolocation.watchPosition(
      (pos) => callback({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      (err) => console.error('[Location] Watch error:', err),
      { enableHighAccuracy: true }
    );
    watchId = String(id);
    return;
  }
  
  watchId = await Geolocation.watchPosition(
    { enableHighAccuracy: true },
    (position, err) => {
      if (err) {
        console.error('[Capacitor] Watch position error:', err);
        return;
      }
      if (position) {
        callback({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
        });
      }
    }
  );
}

export async function stopLocationTracking(): Promise<void> {
  if (!watchId) return;
  
  if (!isNative) {
    navigator.geolocation.clearWatch(Number(watchId));
    watchId = null;
    return;
  }
  
  await Geolocation.clearWatch({ id: watchId });
  watchId = null;
}

export async function showNotification(title: string, body: string): Promise<void> {
  if (!isNative) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
    }
    return;
  }
  
  await LocalNotifications.schedule({
    notifications: [
      {
        id: Date.now(),
        title,
        body,
        schedule: { at: new Date(Date.now() + 100) },
      },
    ],
  });
}

export async function requestNotificationPermissions(): Promise<boolean> {
  if (!isNative) {
    if ('Notification' in window) {
      const result = await Notification.requestPermission();
      return result === 'granted';
    }
    return false;
  }
  
  const status = await LocalNotifications.requestPermissions();
  return status.display === 'granted';
}

export async function checkDndOverridePermission(): Promise<boolean> {
  if (!isNative) {
    return true;
  }
  
  try {
    const { Capacitor } = await import('@capacitor/core');
    const plugins = (Capacitor as any).Plugins;
    if (plugins?.DndOverride) {
      const result = await plugins.DndOverride.isGranted();
      return result.granted;
    }
  } catch (error) {
    console.error('[DND] Failed to check permission:', error);
  }
  return false;
}

export async function requestDndOverridePermission(): Promise<boolean> {
  if (!isNative) {
    console.log('[DND] Not on native platform, permission simulated');
    return true;
  }
  
  try {
    const { Capacitor } = await import('@capacitor/core');
    const plugins = (Capacitor as any).Plugins;
    if (plugins?.DndOverride) {
      await plugins.DndOverride.requestPermission();
      const result = await plugins.DndOverride.isGranted();
      return result.granted;
    }
  } catch (error) {
    console.error('[DND] Failed to request permission:', error);
  }
  return false;
}

export function setupAppLifecycle(
  onResume: () => void,
  onPause: () => void
): void {
  if (!isNative) return;
  
  App.addListener('appStateChange', ({ isActive }) => {
    if (isActive) {
      onResume();
    } else {
      onPause();
    }
  });
}

export async function exitApp(): Promise<void> {
  if (!isNative) {
    window.location.href = '/login';
    return;
  }
  
  await App.exitApp();
}

export interface HardwarePttEvents {
  pttDown: { pressed: true; keyCode: number };
  pttUp: { pressed: false; keyCode: number };
}

let pttDownListeners: ((data: HardwarePttEvents['pttDown']) => void)[] = [];
let pttUpListeners: ((data: HardwarePttEvents['pttUp']) => void)[] = [];

export function addHardwarePttListener(
  event: 'pttDown' | 'pttUp',
  callback: (data: any) => void
): () => void {
  if (event === 'pttDown') {
    pttDownListeners.push(callback);
    return () => {
      pttDownListeners = pttDownListeners.filter(l => l !== callback);
    };
  } else {
    pttUpListeners.push(callback);
    return () => {
      pttUpListeners = pttUpListeners.filter(l => l !== callback);
    };
  }
}

export async function setHardwarePttKeyCode(keyCode: number): Promise<boolean> {
  if (!isNative) {
    console.log('[HardwarePtt] Not on native platform, keyCode stored in settings only');
    return true;
  }
  
  try {
    const { Capacitor } = await import('@capacitor/core');
    const plugins = (Capacitor as any).Plugins;
    if (plugins?.HardwarePtt) {
      await plugins.HardwarePtt.setPttKeyCode({ keyCode });
      return true;
    }
  } catch (error) {
    console.error('[HardwarePtt] Failed to set key code:', error);
  }
  return false;
}

export async function getHardwarePttKeyCode(): Promise<number | null> {
  if (!isNative) {
    return null;
  }
  
  try {
    const { Capacitor } = await import('@capacitor/core');
    const plugins = (Capacitor as any).Plugins;
    if (plugins?.HardwarePtt) {
      const result = await plugins.HardwarePtt.getPttKeyCode();
      return result.keyCode;
    }
  } catch (error) {
    console.error('[HardwarePtt] Failed to get key code:', error);
  }
  return null;
}

export function setupHardwarePttListeners(): () => void {
  if (!isNative) {
    return () => {};
  }
  
  const setupAsync = async () => {
    try {
      const { Capacitor } = await import('@capacitor/core');
      const plugins = (Capacitor as any).Plugins;
      
      if (plugins?.HardwarePtt) {
        plugins.HardwarePtt.addListener('pttDown', (data: HardwarePttEvents['pttDown']) => {
          pttDownListeners.forEach(listener => listener(data));
        });
        
        plugins.HardwarePtt.addListener('pttUp', (data: HardwarePttEvents['pttUp']) => {
          pttUpListeners.forEach(listener => listener(data));
        });
      }
    } catch (error) {
      console.error('[HardwarePtt] Failed to setup listeners:', error);
    }
  };
  
  setupAsync();
  
  return () => {
    pttDownListeners = [];
    pttUpListeners = [];
  };
}
