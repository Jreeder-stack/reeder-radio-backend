/**
 * Native LiveKit Plugin Interface
 * 
 * This module provides a bridge between the web app and the native LiveKit Android SDK.
 * It falls back to the web SDK when running in a browser.
 */

import { Capacitor, registerPlugin } from '@capacitor/core';

export interface NativeLiveKitPlugin {
  connect(options: { url: string; token: string; channelName?: string }): Promise<{ success: boolean; channelName?: string }>;
  disconnect(): Promise<{ success: boolean }>;
  enableMicrophone(): Promise<{ success: boolean; enabled: boolean }>;
  disableMicrophone(): Promise<{ success: boolean; enabled: boolean }>;
  setSpeakerphone(options: { enabled: boolean }): Promise<{ success: boolean; enabled: boolean }>;
  getState(): Promise<{
    isConnected: boolean;
    isMicEnabled: boolean;
    currentChannel: string | null;
    roomState?: string;
  }>;
  isAvailable(): Promise<{ available: boolean; platform: string }>;
  
  // Event listeners
  addListener(eventName: 'connected', listenerFunc: (data: { channelName: string }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'disconnected', listenerFunc: (data: any) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'microphoneEnabled', listenerFunc: (data: { enabled: boolean }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'microphoneDisabled', listenerFunc: (data: { enabled: boolean }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'participantConnected', listenerFunc: (data: { identity: string }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'participantDisconnected', listenerFunc: (data: { identity: string }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'audioReceived', listenerFunc: (data: { identity: string; receiving?: boolean }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'audioStopped', listenerFunc: (data: { identity: string }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'activeSpeakerChanged', listenerFunc: (data: { identity: string; speaking: boolean }) => void): Promise<{ remove: () => void }>;
  addListener(eventName: 'trackUnsubscribed', listenerFunc: (data: { identity: string; kind: string }) => void): Promise<{ remove: () => void }>;
  removeAllListeners(): Promise<void>;
}

// Register the plugin - web implementation is a simple stub
const NativeLiveKit = registerPlugin<NativeLiveKitPlugin>('NativeLiveKit');

export { NativeLiveKit };

/**
 * Check if native LiveKit is available
 */
export async function isNativeLiveKitAvailable(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) {
    return false;
  }
  
  try {
    const result = await NativeLiveKit.isAvailable();
    return result.available;
  } catch {
    return false;
  }
}

/**
 * Get the platform we're running on
 */
export function getLiveKitPlatform(): 'native-android' | 'native-ios' | 'web' {
  if (Capacitor.getPlatform() === 'android') {
    return 'native-android';
  } else if (Capacitor.getPlatform() === 'ios') {
    return 'native-ios';
  }
  return 'web';
}
