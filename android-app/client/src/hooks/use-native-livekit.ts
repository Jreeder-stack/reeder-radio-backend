/**
 * Hook for using native LiveKit on Android
 * 
 * This hook provides a unified interface that:
 * - Uses native LiveKit SDK on Android (bypasses WebView WebRTC issues)
 * - Falls back to web SDK on other platforms
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Capacitor } from '@capacitor/core';
import { NativeLiveKit, isNativeLiveKitAvailable } from '@/lib/native-livekit';
import { apiClient } from '@/lib/api-client';
import { playTalkPermitTone, playEndOfTransmissionTone } from '@/lib/audio-tones';

interface UseNativeLiveKitOptions {
  channelName: string | null;
  identity?: string | null;
  enabled?: boolean;
}

interface UseNativeLiveKitReturn {
  isConnected: boolean;
  isConnecting: boolean;
  isMuted: boolean;
  error: string | null;
  isNative: boolean;
  startTransmitting: () => Promise<void>;
  stopTransmitting: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useNativeLiveKit(options: UseNativeLiveKitOptions): UseNativeLiveKitReturn {
  const { channelName, identity, enabled = true } = options;
  
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isNativeAvailable, setIsNativeAvailable] = useState(false);
  
  const currentChannelRef = useRef<string | null>(null);
  
  // Check if native LiveKit is available on mount
  useEffect(() => {
    const checkNative = async () => {
      const available = await isNativeLiveKitAvailable();
      setIsNativeAvailable(available);
      console.log('[NativeLiveKit] Native available:', available);
    };
    checkNative();
  }, []);
  
  // Connect to room
  const connect = useCallback(async (channel: string, userIdentity?: string | null) => {
    console.log('[NativeLiveKit] Connecting to:', channel, 'as:', userIdentity);
    
    if (!isNativeAvailable) {
      console.log('[NativeLiveKit] Native not available, cannot connect');
      setError('Native LiveKit not available');
      return;
    }
    
    setIsConnecting(true);
    setError(null);
    
    try {
      // Get token from server
      console.log('[NativeLiveKit] Requesting token for channel:', channel);
      const tokenResponse = await apiClient.getLiveKitToken(channel, userIdentity || undefined);
      
      if (!tokenResponse.success || !tokenResponse.data) {
        throw new Error(tokenResponse.error || 'Failed to get LiveKit token');
      }
      
      const { token, url } = tokenResponse.data;
      
      if (!token || !url) {
        throw new Error('Invalid token response from server');
      }
      
      console.log('[NativeLiveKit] Got token, connecting to:', url);
      
      // Connect using native plugin
      const result = await NativeLiveKit.connect({
        url,
        token,
        channelName: channel,
      });
      
      if (result.success) {
        console.log('[NativeLiveKit] Connected successfully');
        setIsConnected(true);
        currentChannelRef.current = channel;
      } else {
        throw new Error('Connection failed');
      }
      
    } catch (err) {
      console.error('[NativeLiveKit] Connection error:', err);
      setError(err instanceof Error ? err.message : 'Connection failed');
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  }, [isNativeAvailable]);
  
  // Disconnect from room
  const disconnect = useCallback(async () => {
    console.log('[NativeLiveKit] Disconnecting');
    
    if (!isNativeAvailable) return;
    
    try {
      await NativeLiveKit.disconnect();
      setIsConnected(false);
      setIsMuted(true);
      currentChannelRef.current = null;
    } catch (err) {
      console.error('[NativeLiveKit] Disconnect error:', err);
    }
  }, [isNativeAvailable]);
  
  // Start transmitting (enable mic)
  const startTransmitting = useCallback(async () => {
    console.log('[NativeLiveKit] Starting transmission');
    
    if (!isNativeAvailable || !isConnected) {
      console.warn('[NativeLiveKit] Cannot transmit - not connected or native unavailable');
      setError('Not connected to channel');
      return;
    }
    
    try {
      const result = await NativeLiveKit.enableMicrophone();
      
      if (result.success) {
        console.log('[NativeLiveKit] Microphone enabled');
        setIsMuted(false);
        setError(null);
        playTalkPermitTone();
        
        // Update status on server
        apiClient.updateStatus('transmitting', currentChannelRef.current || undefined).catch(console.error);
      }
    } catch (err) {
      console.error('[NativeLiveKit] Failed to enable microphone:', err);
      setError(err instanceof Error ? err.message : 'Failed to transmit');
    }
  }, [isNativeAvailable, isConnected]);
  
  // Stop transmitting (disable mic)
  const stopTransmitting = useCallback(async () => {
    console.log('[NativeLiveKit] Stopping transmission');
    
    if (!isNativeAvailable) return;
    
    try {
      await NativeLiveKit.disableMicrophone();
      console.log('[NativeLiveKit] Microphone disabled');
      setIsMuted(true);
      playEndOfTransmissionTone();
      
      // Update status on server
      apiClient.updateStatus('idle', currentChannelRef.current || undefined).catch(console.error);
    } catch (err) {
      console.error('[NativeLiveKit] Failed to disable microphone:', err);
    }
  }, [isNativeAvailable]);
  
  // Set up event listeners
  useEffect(() => {
    if (!isNativeAvailable) return;
    
    const listeners: Array<{ remove: () => void }> = [];
    
    const setupListeners = async () => {
      // Connected event
      const connectedListener = await NativeLiveKit.addListener('connected', (data) => {
        console.log('[NativeLiveKit] Event: connected', data);
        setIsConnected(true);
      });
      listeners.push(connectedListener);
      
      // Disconnected event
      const disconnectedListener = await NativeLiveKit.addListener('disconnected', (data) => {
        console.log('[NativeLiveKit] Event: disconnected', data);
        setIsConnected(false);
        setIsMuted(true);
      });
      listeners.push(disconnectedListener);
    };
    
    setupListeners();
    
    return () => {
      listeners.forEach(l => l.remove());
    };
  }, [isNativeAvailable]);
  
  // Main connection effect
  useEffect(() => {
    console.log('[NativeLiveKit] Effect triggered:', { enabled, channelName, identity, isNativeAvailable });
    
    if (!isNativeAvailable) {
      console.log('[NativeLiveKit] Native not available, skipping');
      return;
    }
    
    if (enabled && channelName) {
      const effectiveIdentity = identity || 'Unknown-Unit';
      connect(channelName, effectiveIdentity);
    } else {
      disconnect();
    }
  }, [channelName, identity, enabled, isNativeAvailable]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (isNativeAvailable) {
        NativeLiveKit.disconnect().catch(console.error);
        NativeLiveKit.removeAllListeners().catch(console.error);
      }
    };
  }, [isNativeAvailable]);
  
  return {
    isConnected,
    isConnecting,
    isMuted,
    error,
    isNative: isNativeAvailable,
    startTransmitting,
    stopTransmitting,
    disconnect,
  };
}
