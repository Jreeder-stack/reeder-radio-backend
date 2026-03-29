// Compatibility shim: legacy imports should migrate to nativeAudioBridge.
export * from './nativeAudioBridge';
export { default } from './nativeAudioBridge';
export { isNativeAudioBridgeAvailable as isNativeLiveKitAvailable } from './nativeAudioBridge';
