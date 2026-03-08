const isNative = typeof window !== 'undefined' &&
  window.Capacitor?.isNativePlatform?.() === true;

let NativeLiveKit = null;

if (isNative && window.Capacitor?.registerPlugin) {
  NativeLiveKit = window.Capacitor.registerPlugin('NativeLiveKit');
}

export function isNativeLiveKitAvailable() {
  return isNative && NativeLiveKit !== null;
}

export async function nativeConnect(url, token, channelName) {
  if (!NativeLiveKit) return false;
  try {
    const result = await NativeLiveKit.connect({ url, token, channelName });
    console.log('[NativeLiveKit] Connected to', channelName);
    return result?.success === true;
  } catch (e) {
    console.error('[NativeLiveKit] Connect failed:', e);
    return false;
  }
}

export async function nativeDisconnect() {
  if (!NativeLiveKit) return false;
  try {
    const result = await NativeLiveKit.disconnect({});
    console.log('[NativeLiveKit] Disconnected');
    return result?.success === true;
  } catch (e) {
    console.error('[NativeLiveKit] Disconnect failed:', e);
    return false;
  }
}

export async function nativeEnableMic() {
  if (!NativeLiveKit) return false;
  try {
    const result = await NativeLiveKit.enableMicrophone({});
    console.log('[NativeLiveKit] Mic enabled');
    return result?.success === true;
  } catch (e) {
    console.error('[NativeLiveKit] Enable mic failed:', e);
    return false;
  }
}

export async function nativeDisableMic() {
  if (!NativeLiveKit) return false;
  try {
    const result = await NativeLiveKit.disableMicrophone({});
    console.log('[NativeLiveKit] Mic disabled');
    return result?.success === true;
  } catch (e) {
    console.error('[NativeLiveKit] Disable mic failed:', e);
    return false;
  }
}

export async function nativeGetState() {
  if (!NativeLiveKit) return null;
  try {
    return await NativeLiveKit.getState({});
  } catch (e) {
    console.error('[NativeLiveKit] getState failed:', e);
    return null;
  }
}

export async function nativeIsAvailable() {
  if (!NativeLiveKit) return false;
  try {
    const result = await NativeLiveKit.isAvailable({});
    return result?.available === true;
  } catch (e) {
    return false;
  }
}

let _eventListeners = {};

export function addNativeListener(eventName, callback) {
  if (!NativeLiveKit) return () => {};
  try {
    const handle = NativeLiveKit.addListener(eventName, callback);
    if (!_eventListeners[eventName]) _eventListeners[eventName] = [];
    _eventListeners[eventName].push({ handle, callback });
    return () => {
      if (handle?.remove) handle.remove();
      _eventListeners[eventName] = _eventListeners[eventName].filter(l => l.callback !== callback);
    };
  } catch (e) {
    console.warn('[NativeLiveKit] addListener failed for', eventName, e);
    return () => {};
  }
}

let _BackgroundService = null;
function getBackgroundService() {
  if (!isNative) return null;
  if (!_BackgroundService && window.Capacitor?.registerPlugin) {
    _BackgroundService = window.Capacitor.registerPlugin('BackgroundService');
  }
  return _BackgroundService;
}

export async function updateServiceConnectionInfo(serverBaseUrl, unitId, channelId) {
  if (!isNative) return;
  const svc = getBackgroundService();
  if (!svc) return;
  try {
    let running = false;
    try {
      const status = await svc.isServiceRunning();
      running = status?.running === true;
    } catch (_) {}

    if (!running) {
      console.log('[NativeLiveKit] Starting background service before updating connection info');
      await svc.startService();
    }

    await svc.updateConnectionInfo({ serverBaseUrl, unitId, channelId });
    console.log('[NativeLiveKit] Service connection info updated:', { serverBaseUrl, unitId, channelId });
  } catch (e) {
    console.warn('[NativeLiveKit] Failed to update service connection info:', e);
  }
}

export default {
  isNativeLiveKitAvailable,
  nativeConnect,
  nativeDisconnect,
  nativeEnableMic,
  nativeDisableMic,
  nativeGetState,
  nativeIsAvailable,
  addNativeListener,
  updateServiceConnectionInfo,
};
