/**
 * Combined LiveKit Hook
 * 
 * Automatically selects between native LiveKit SDK (Android) and web SDK (browser).
 * This provides seamless PTT functionality across platforms.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { NativeLiveKit, isNativeLiveKitAvailable } from '@/lib/native-livekit';
import { apiClient } from '@/lib/api-client';
import { playTalkPermitTone, playEndOfTransmissionTone } from '@/lib/audio-tones';
import { requestMicrophonePermission } from '@/lib/capacitor';
import {
  Room,
  RoomEvent,
  Track,
  RemoteParticipant,
  RemoteTrackPublication,
  ConnectionState,
} from 'livekit-client';

interface UseLiveKitOptions {
  channelName: string | null;
  identity?: string | null;
  enabled?: boolean;
}

interface UseLiveKitReturn {
  isConnected: boolean;
  isConnecting: boolean;
  isMuted: boolean;
  isReceiving: boolean;
  activeSpeaker: string | null;
  error: string | null;
  participants: string[];
  isNative: boolean;
  setMuted: (muted: boolean) => void;
  startTransmitting: () => Promise<void>;
  stopTransmitting: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useLiveKitCombined({ channelName, identity, enabled = true }: UseLiveKitOptions): UseLiveKitReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isReceiving, setIsReceiving] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [useNative, setUseNative] = useState(false);
  const [nativeChecked, setNativeChecked] = useState(false);
  
  const roomRef = useRef<Room | null>(null);
  const currentChannelRef = useRef<string | null>(null);
  const activeRemoteTracksRef = useRef<Set<string>>(new Set());

  // Check if native LiveKit is available on mount
  useEffect(() => {
    const checkNative = async () => {
      if (Capacitor.getPlatform() === 'android') {
        const available = await isNativeLiveKitAvailable();
        console.log('[LiveKit Combined] Native check:', { platform: 'android', available });
        setUseNative(available);
      } else {
        console.log('[LiveKit Combined] Using web SDK (not on Android)');
        setUseNative(false);
      }
      setNativeChecked(true);
    };
    checkNative();
  }, []);

  // ============= WEB SDK HANDLERS =============
  const updateParticipants = useCallback((room: Room) => {
    const names: string[] = [];
    room.remoteParticipants.forEach((participant) => {
      names.push(participant.identity);
    });
    setParticipants(names);
  }, []);

  const handleTrackSubscribed = useCallback(
    (track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        const audioElement = track.attach();
        audioElement.id = `audio-${participant.identity}`;
        document.body.appendChild(audioElement);
        console.log(`[LiveKit Web] Subscribed to audio from ${participant.identity}`);
        
        activeRemoteTracksRef.current.add(participant.identity);
        setIsReceiving(true);
        setActiveSpeaker(participant.identity);
      }
    },
    []
  );

  const handleTrackUnsubscribed = useCallback(
    (track: Track, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind === Track.Kind.Audio) {
        track.detach().forEach((el) => el.remove());
        console.log(`[LiveKit Web] Unsubscribed from audio of ${participant.identity}`);
        
        activeRemoteTracksRef.current.delete(participant.identity);
        if (activeRemoteTracksRef.current.size === 0) {
          setIsReceiving(false);
          setActiveSpeaker(null);
        } else {
          const remaining = Array.from(activeRemoteTracksRef.current);
          setActiveSpeaker(remaining[0]);
        }
      }
    },
    []
  );

  const handleParticipantConnected = useCallback(
    (participant: RemoteParticipant) => {
      console.log(`[LiveKit Web] Participant connected: ${participant.identity}`);
      if (roomRef.current) {
        updateParticipants(roomRef.current);
      }
    },
    [updateParticipants]
  );

  const handleParticipantDisconnected = useCallback(
    (participant: RemoteParticipant) => {
      console.log(`[LiveKit Web] Participant disconnected: ${participant.identity}`);
      const audioEl = document.getElementById(`audio-${participant.identity}`);
      if (audioEl) audioEl.remove();
      if (roomRef.current) {
        updateParticipants(roomRef.current);
      }
    },
    [updateParticipants]
  );

  // ============= NATIVE SDK CONNECT =============
  const connectNative = useCallback(async (channel: string, userIdentity?: string | null) => {
    console.log('[LiveKit Native] Connecting to:', channel, 'as:', userIdentity);
    
    setIsConnecting(true);
    setError(null);
    
    try {
      // Get token from server
      const tokenResponse = await apiClient.getLiveKitToken(channel, userIdentity || undefined);
      
      if (!tokenResponse.success || !tokenResponse.data) {
        throw new Error(tokenResponse.error || 'Failed to get LiveKit token');
      }
      
      const { token, url } = tokenResponse.data;
      
      if (!token || !url) {
        throw new Error('Invalid token response from server');
      }
      
      console.log('[LiveKit Native] Got token, connecting to:', url);
      
      // Connect using native plugin
      const result = await NativeLiveKit.connect({
        url,
        token,
        channelName: channel,
      });
      
      if (result.success) {
        console.log('[LiveKit Native] Connected successfully');
        setIsConnected(true);
        currentChannelRef.current = channel;
      } else {
        throw new Error('Connection failed');
      }
      
    } catch (err) {
      console.error('[LiveKit Native] Connection error:', err);
      setError(err instanceof Error ? err.message : 'Connection failed');
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  // ============= WEB SDK CONNECT =============
  const connectWeb = useCallback(async (channel: string, userIdentity?: string | null) => {
    console.log('[LiveKit Web] Connect called:', { channel, userIdentity });
    
    if (roomRef.current?.state === ConnectionState.Connected && currentChannelRef.current === channel) {
      console.log('[LiveKit Web] Already connected to this channel');
      return;
    }

    if (roomRef.current) {
      console.log('[LiveKit Web] Disconnecting from previous room');
      await roomRef.current.disconnect();
      roomRef.current = null;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const micGranted = await requestMicrophonePermission();
      if (!micGranted) {
        throw new Error('Microphone permission denied');
      }

      const response = await apiClient.getLiveKitToken(channel, userIdentity || undefined);
      
      if (!response.success || !response.data) {
        throw new Error(response.error || 'Failed to get LiveKit token');
      }

      const { token, url } = response.data;

      if (!token || !url) {
        throw new Error('Invalid token response from server');
      }

      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
      room.on(RoomEvent.TrackUnsubscribed, handleTrackUnsubscribed);
      room.on(RoomEvent.ParticipantConnected, handleParticipantConnected);
      room.on(RoomEvent.ParticipantDisconnected, handleParticipantDisconnected);
      
      // Active speaker detection - this is the key event for knowing who is actually talking
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        // Filter out local participant
        const remoteSpeakers = speakers.filter(s => s.identity !== room.localParticipant.identity);
        console.log('[LiveKit Web] Active speakers changed:', remoteSpeakers.map(s => s.identity));
        
        if (remoteSpeakers.length > 0) {
          setIsReceiving(true);
          setActiveSpeaker(remoteSpeakers[0].identity);
        } else {
          setIsReceiving(false);
          setActiveSpeaker(null);
        }
      });
      
      room.on(RoomEvent.Disconnected, (reason) => {
        console.log('[LiveKit Web] Disconnected from room, reason:', reason);
        setIsConnected(false);
        setParticipants([]);
        setIsReceiving(false);
        setActiveSpeaker(null);
      });

      room.on(RoomEvent.Reconnecting, () => {
        console.log('[LiveKit Web] Reconnecting...');
      });

      room.on(RoomEvent.Reconnected, () => {
        console.log('[LiveKit Web] Reconnected');
        setIsConnected(true);
      });

      console.log('[LiveKit Web] Connecting to:', url);
      await room.connect(url, token);
      
      try {
        await room.startAudio();
        console.log('[LiveKit Web] Audio context started');
      } catch (audioErr) {
        console.warn('[LiveKit Web] Could not start audio context:', audioErr);
      }
      
      console.log(`[LiveKit Web] Connected to room: ${channel}`);
      roomRef.current = room;
      currentChannelRef.current = channel;
      setIsConnected(true);
      updateParticipants(room);

    } catch (err) {
      console.error('[LiveKit Web] Connection error:', err);
      setError(err instanceof Error ? err.message : 'Connection failed');
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  }, [handleTrackSubscribed, handleTrackUnsubscribed, handleParticipantConnected, handleParticipantDisconnected, updateParticipants]);

  // ============= UNIFIED CONNECT =============
  const connect = useCallback(async (channel: string, userIdentity?: string | null) => {
    if (useNative) {
      await connectNative(channel, userIdentity);
    } else {
      await connectWeb(channel, userIdentity);
    }
  }, [useNative, connectNative, connectWeb]);

  // ============= DISCONNECT =============
  const disconnect = useCallback(async () => {
    if (useNative) {
      try {
        await NativeLiveKit.disconnect();
      } catch (err) {
        console.error('[LiveKit Native] Disconnect error:', err);
      }
    } else {
      if (roomRef.current) {
        try {
          await roomRef.current.localParticipant.setMicrophoneEnabled(false);
        } catch (e) {}
        roomRef.current.disconnect();
        roomRef.current = null;
      }
    }
    
    currentChannelRef.current = null;
    activeRemoteTracksRef.current.clear();
    setIsConnected(false);
    setParticipants([]);
    setIsMuted(true);
    setIsReceiving(false);
    setActiveSpeaker(null);
  }, [useNative]);

  // ============= TRANSMIT CONTROLS =============
  const startTransmitting = useCallback(async () => {
    if (useNative) {
      try {
        const result = await NativeLiveKit.enableMicrophone();
        if (result.success) {
          setIsMuted(false);
          setError(null);
          playTalkPermitTone();
          apiClient.updateStatus('transmitting', currentChannelRef.current || undefined).catch(console.error);
        }
      } catch (err) {
        console.error('[LiveKit Native] Failed to enable microphone:', err);
        setError(err instanceof Error ? err.message : 'Failed to transmit');
      }
    } else {
      const room = roomRef.current;
      if (!room || room.state !== ConnectionState.Connected) {
        setError('Not connected to channel');
        return;
      }

      try {
        await room.startAudio();
        await room.localParticipant.setMicrophoneEnabled(true);
        console.log('[LiveKit Web] Microphone enabled');
        
        setIsMuted(false);
        setError(null);
        playTalkPermitTone();
        
        apiClient.updateStatus('transmitting', currentChannelRef.current || undefined).catch(console.error);
      } catch (err) {
        console.error('[LiveKit Web] Failed to start transmitting:', err);
        setError(err instanceof Error ? err.message : 'Failed to transmit');
      }
    }
  }, [useNative]);

  const stopTransmitting = useCallback(async () => {
    if (useNative) {
      try {
        await NativeLiveKit.disableMicrophone();
        playEndOfTransmissionTone();
      } catch (err) {
        console.error('[LiveKit Native] Failed to disable microphone:', err);
      }
    } else {
      const room = roomRef.current;
      if (room && room.state === ConnectionState.Connected) {
        try {
          await room.localParticipant.setMicrophoneEnabled(false);
          console.log('[LiveKit Web] Microphone disabled');
        } catch (err) {
          console.error('[LiveKit Web] Failed to disable microphone:', err);
        }
      }
    }
    
    setIsMuted(true);
    apiClient.updateStatus('idle', currentChannelRef.current || undefined).catch(console.error);
  }, [useNative]);

  const setMuted = useCallback((muted: boolean) => {
    if (muted) {
      stopTransmitting();
    } else {
      startTransmitting();
    }
  }, [startTransmitting, stopTransmitting]);

  // ============= NATIVE EVENT LISTENERS =============
  useEffect(() => {
    if (!useNative || !nativeChecked) return;

    const listeners: Array<{ remove: () => void }> = [];
    
    const setupListeners = async () => {
      const connectedListener = await NativeLiveKit.addListener('connected', (data) => {
        console.log('[LiveKit Native] Event: connected', data);
        setIsConnected(true);
      });
      listeners.push(connectedListener);
      
      const disconnectedListener = await NativeLiveKit.addListener('disconnected', (data) => {
        console.log('[LiveKit Native] Event: disconnected', data);
        setIsConnected(false);
        setIsMuted(true);
      });
      listeners.push(disconnectedListener);

      const participantConnectedListener = await NativeLiveKit.addListener('participantConnected', (data) => {
        console.log('[LiveKit Native] Participant connected:', data.identity);
        setParticipants(prev => [...prev, data.identity]);
      });
      listeners.push(participantConnectedListener);

      const participantDisconnectedListener = await NativeLiveKit.addListener('participantDisconnected', (data) => {
        console.log('[LiveKit Native] Participant disconnected:', data.identity);
        setParticipants(prev => prev.filter(p => p !== data.identity));
      });
      listeners.push(participantDisconnectedListener);

      // Active speaker detection - this properly tracks who is actually talking
      const activeSpeakerListener = await NativeLiveKit.addListener('activeSpeakerChanged', (data) => {
        console.log('[LiveKit Native] Active speaker changed:', data);
        if (data.speaking && data.identity) {
          setIsReceiving(true);
          setActiveSpeaker(data.identity);
        } else {
          setIsReceiving(false);
          setActiveSpeaker(null);
        }
      });
      listeners.push(activeSpeakerListener);

      // Fallback: Track unsubscribed - clear receiving when audio track is removed
      const trackUnsubscribedListener = await NativeLiveKit.addListener('trackUnsubscribed', (data) => {
        console.log('[LiveKit Native] Track unsubscribed:', data);
        if (data.kind === 'audio') {
          // Clear receiving state when remote audio track is removed
          setIsReceiving(false);
          setActiveSpeaker(null);
        }
      });
      listeners.push(trackUnsubscribedListener);
    };
    
    setupListeners();
    
    return () => {
      listeners.forEach(l => l.remove());
    };
  }, [useNative, nativeChecked]);

  // ============= MAIN CONNECTION EFFECT =============
  useEffect(() => {
    if (!nativeChecked) return; // Wait for native check to complete
    
    console.log('[LiveKit Combined] Effect triggered:', { enabled, channelName, identity, useNative });
    
    if (enabled && channelName) {
      const effectiveIdentity = identity || 'Unknown-Unit';
      console.log('[LiveKit Combined] Connecting with:', { channel: channelName, identity: effectiveIdentity, useNative });
      connect(channelName, effectiveIdentity);
    } else {
      disconnect();
    }
  }, [channelName, identity, enabled, nativeChecked, useNative]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('[LiveKit Combined] Unmounting, disconnecting');
      disconnect();
      if (useNative) {
        NativeLiveKit.removeAllListeners().catch(console.error);
      }
    };
  }, []);

  return {
    isConnected,
    isConnecting,
    isMuted,
    isReceiving,
    activeSpeaker,
    error,
    participants,
    isNative: useNative,
    setMuted,
    startTransmitting,
    stopTransmitting,
    disconnect,
  };
}
