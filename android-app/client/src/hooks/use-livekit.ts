import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  RemoteParticipant,
  RemoteTrackPublication,
  ConnectionState,
} from 'livekit-client';
import { apiClient } from '@/lib/api-client';
import { playTalkPermitTone } from '@/lib/audio-tones';
import { requestMicrophonePermission, isNative } from '@/lib/capacitor';

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
  setMuted: (muted: boolean) => void;
  startTransmitting: () => Promise<void>;
  stopTransmitting: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useLiveKit({ channelName, identity, enabled = true }: UseLiveKitOptions): UseLiveKitReturn {
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(true);
  const [isReceiving, setIsReceiving] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  
  const roomRef = useRef<Room | null>(null);
  const currentChannelRef = useRef<string | null>(null);
  const activeRemoteTracksRef = useRef<Set<string>>(new Set());

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
        console.log(`[LiveKit] Subscribed to audio from ${participant.identity}`);
        
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
        console.log(`[LiveKit] Unsubscribed from audio of ${participant.identity}`);
        
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
      console.log(`[LiveKit] Participant connected: ${participant.identity}`);
      if (roomRef.current) {
        updateParticipants(roomRef.current);
      }
    },
    [updateParticipants]
  );

  const handleParticipantDisconnected = useCallback(
    (participant: RemoteParticipant) => {
      console.log(`[LiveKit] Participant disconnected: ${participant.identity}`);
      const audioEl = document.getElementById(`audio-${participant.identity}`);
      if (audioEl) audioEl.remove();
      if (roomRef.current) {
        updateParticipants(roomRef.current);
      }
    },
    [updateParticipants]
  );

  const connect = useCallback(async (channel: string, userIdentity?: string | null) => {
    console.log('[LiveKit] Connect called:', { channel, userIdentity, isNative });
    
    if (roomRef.current?.state === ConnectionState.Connected && currentChannelRef.current === channel) {
      console.log('[LiveKit] Already connected to this channel');
      return;
    }

    if (roomRef.current) {
      console.log('[LiveKit] Disconnecting from previous room');
      await roomRef.current.disconnect();
      roomRef.current = null;
    }

    setIsConnecting(true);
    setError(null);

    try {
      console.log('[LiveKit] Requesting microphone permission first...');
      const micGranted = await requestMicrophonePermission();
      console.log('[LiveKit] Microphone permission result:', micGranted);
      
      if (!micGranted) {
        throw new Error('Microphone permission denied - please allow microphone access in your device settings');
      }

      console.log('[LiveKit] Requesting token for channel:', channel);
      const response = await apiClient.getLiveKitToken(channel, userIdentity || undefined);
      console.log('[LiveKit] Token response:', { success: response.success, hasData: !!response.data });
      
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
      
      room.on(RoomEvent.Disconnected, (reason) => {
        console.log('[LiveKit] Disconnected from room, reason:', reason);
        console.log('[LiveKit] Disconnect details:', {
          reason: reason,
          roomState: room.state
        });
        setIsConnected(false);
        setParticipants([]);
      });

      room.on(RoomEvent.Reconnecting, () => {
        console.log('[LiveKit] Reconnecting...');
      });

      room.on(RoomEvent.Reconnected, () => {
        console.log('[LiveKit] Reconnected');
        setIsConnected(true);
      });

      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        console.log('[LiveKit] Connection state changed:', state);
      });

      room.on(RoomEvent.MediaDevicesError, (error) => {
        console.error('[LiveKit] Media devices error:', error);
        setError('Media device error: ' + error.message);
      });

      room.on(RoomEvent.SignalConnected, () => {
        console.log('[LiveKit] Signal connected (WebSocket established)');
      });

      console.log('[LiveKit] Attempting room.connect() to:', url);
      await room.connect(url, token);
      console.log('[LiveKit] room.connect() succeeded!');
      
      // Start audio context for mobile devices (required for WebView)
      try {
        await room.startAudio();
        console.log('[LiveKit] Audio context started');
      } catch (audioErr) {
        console.warn('[LiveKit] Could not start audio context:', audioErr);
      }
      
      console.log(`[LiveKit] Fully connected to room: ${channel}`);
      roomRef.current = room;
      currentChannelRef.current = channel;
      setIsConnected(true);
      updateParticipants(room);

    } catch (err) {
      console.error('[LiveKit] Connection error:', err);
      setError(err instanceof Error ? err.message : 'Connection failed');
      setIsConnected(false);
    } finally {
      setIsConnecting(false);
    }
  }, [handleTrackSubscribed, handleTrackUnsubscribed, handleParticipantConnected, handleParticipantDisconnected, updateParticipants]);

  const disconnect = useCallback(async () => {
    if (roomRef.current) {
      try {
        // Disable microphone before disconnecting
        await roomRef.current.localParticipant.setMicrophoneEnabled(false);
      } catch (e) {
        // Ignore errors when disabling mic during disconnect
      }
      roomRef.current.disconnect();
      roomRef.current = null;
    }
    currentChannelRef.current = null;
    activeRemoteTracksRef.current.clear();
    setIsConnected(false);
    setParticipants([]);
    setIsMuted(true);
    setIsReceiving(false);
    setActiveSpeaker(null);
  }, []);

  const startTransmitting = useCallback(async () => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) {
      console.warn('[LiveKit] Cannot transmit - not connected');
      setError('Not connected to channel');
      return;
    }

    try {
      // Ensure audio context is started (required for Android WebView)
      await room.startAudio();
      
      // Enable microphone using LiveKit's built-in method (handles permissions)
      await room.localParticipant.setMicrophoneEnabled(true);
      console.log('[LiveKit] Microphone enabled');
      
      setIsMuted(false);
      setError(null);
      
      // Play talk permit tone after transmission is established
      playTalkPermitTone();
      
      apiClient.updateStatus('transmitting', currentChannelRef.current || undefined).catch(err => {
        console.error('[LiveKit] Failed to update status:', err);
      });
    } catch (err) {
      console.error('[LiveKit] Failed to start transmitting:', err);
      setError(err instanceof Error ? err.message : 'Failed to transmit - check microphone permissions');
    }
  }, []);

  const stopTransmitting = useCallback(async () => {
    const room = roomRef.current;
    if (room && room.state === ConnectionState.Connected) {
      try {
        // Disable microphone using LiveKit's built-in method
        await room.localParticipant.setMicrophoneEnabled(false);
        console.log('[LiveKit] Microphone disabled');
      } catch (err) {
        console.error('[LiveKit] Failed to disable microphone:', err);
      }
    }
    setIsMuted(true);
    
    apiClient.updateStatus('idle', currentChannelRef.current || undefined).catch(err => {
      console.error('[LiveKit] Failed to update status:', err);
    });
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    if (muted) {
      stopTransmitting();
    } else {
      startTransmitting();
    }
  }, [startTransmitting, stopTransmitting]);

  // Main connection effect - NO cleanup function to avoid premature disconnects
  // connect() already handles disconnecting from previous room before connecting to new one
  useEffect(() => {
    console.log('[LiveKit] Effect triggered:', { enabled, channelName, identity });
    
    if (enabled && channelName) {
      const effectiveIdentity = identity || 'Unknown-Unit';
      console.log('[LiveKit] Connecting with identity:', effectiveIdentity);
      connect(channelName, effectiveIdentity);
    } else {
      console.log('[LiveKit] Not connecting - missing requirements:', { enabled, hasChannelName: !!channelName });
      disconnect();
    }
    // NO cleanup here - connect() handles room switching, cleanup only on unmount
  }, [channelName, identity, enabled]);
  
  // Unmount-only cleanup - disconnect when component is removed from DOM
  useEffect(() => {
    return () => {
      console.log('[LiveKit] Component unmounting, disconnecting');
      disconnect();
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
    setMuted,
    startTransmitting,
    stopTransmitting,
    disconnect,
  };
}
