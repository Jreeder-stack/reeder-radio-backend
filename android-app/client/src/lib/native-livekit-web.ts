/**
 * Web fallback implementation for NativeLiveKit plugin
 * 
 * This is a stub that returns "not available" when running in a browser.
 * The actual web implementation should use the regular livekit-client SDK.
 */

import type { NativeLiveKitPlugin } from './native-livekit';

export class NativeLiveKitWeb implements NativeLiveKitPlugin {
  private listeners: Map<string, Set<Function>> = new Map();
  
  async connect(_options: { url: string; token: string; channelName?: string }): Promise<{ success: boolean; channelName?: string }> {
    console.log('[NativeLiveKit Web] connect() called - native not available, use web SDK');
    throw new Error('Native LiveKit not available on web. Use livekit-client SDK instead.');
  }
  
  async disconnect(): Promise<{ success: boolean }> {
    console.log('[NativeLiveKit Web] disconnect() called - native not available');
    throw new Error('Native LiveKit not available on web. Use livekit-client SDK instead.');
  }
  
  async enableMicrophone(): Promise<{ success: boolean; enabled: boolean }> {
    console.log('[NativeLiveKit Web] enableMicrophone() called - native not available');
    throw new Error('Native LiveKit not available on web. Use livekit-client SDK instead.');
  }
  
  async disableMicrophone(): Promise<{ success: boolean; enabled: boolean }> {
    console.log('[NativeLiveKit Web] disableMicrophone() called - native not available');
    throw new Error('Native LiveKit not available on web. Use livekit-client SDK instead.');
  }
  
  async getState(): Promise<{
    isConnected: boolean;
    isMicEnabled: boolean;
    currentChannel: string | null;
    roomState?: string;
  }> {
    return {
      isConnected: false,
      isMicEnabled: false,
      currentChannel: null,
    };
  }
  
  async isAvailable(): Promise<{ available: boolean; platform: string }> {
    return {
      available: false,
      platform: 'web',
    };
  }
  
  async addListener(eventName: string, listenerFunc: Function): Promise<{ remove: () => void }> {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName)!.add(listenerFunc);
    
    return {
      remove: () => {
        this.listeners.get(eventName)?.delete(listenerFunc);
      }
    };
  }
  
  async removeAllListeners(): Promise<void> {
    this.listeners.clear();
  }
}
