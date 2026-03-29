export function isNativeLiveKitAvailable() {
  return false;
}

export async function nativeConnect() {
  return false;
}

export async function nativeDisconnect() {
  return false;
}

export async function nativeEnableMic() {
  return false;
}

export async function nativeDisableMic() {
  return false;
}

export async function nativeGetState() {
  return null;
}

export async function nativeIsAvailable() {
  return false;
}

export function addNativeListener() {
  return () => {};
}

export async function updateServiceConnectionInfo() {
  return;
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
