import { useEffect, useState, useCallback, useRef } from 'react';
import { onDemandVoiceManager, VOICE_STATE } from './OnDemandVoiceManager.js';
import { micPTTManager, PTT_STATES } from './MicPTTManager.js';

export function useOnDemandVoice(channelId) {
  const [voiceState, setVoiceState] = useState(VOICE_STATE.DISCONNECTED);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [error, setError] = useState(null);
  const identityRef = useRef(null);

  useEffect(() => {
    const removeStateListener = onDemandVoiceManager.on('stateChange', (data) => {
      if (data.channelId === channelId) {
        setVoiceState(data.state);
        setIsTransmitting(data.state === VOICE_STATE.TRANSMITTING);
      }
    });

    const removeErrorListener = onDemandVoiceManager.on('connectionError', (data) => {
      if (data.channelId === channelId) {
        setError(data.error);
        setTimeout(() => setError(null), 5000);
      }
    });

    setVoiceState(onDemandVoiceManager.getState(channelId));

    return () => {
      removeStateListener();
      removeErrorListener();
    };
  }, [channelId]);

  const startTransmission = useCallback(async (identity) => {
    if (!channelId) return false;
    identityRef.current = identity;
    
    try {
      setError(null);
      const room = await onDemandVoiceManager.startTransmission(channelId, identity);
      return room;
    } catch (err) {
      setError(err);
      return null;
    }
  }, [channelId]);

  const endTransmission = useCallback(async () => {
    if (!channelId) return;
    await onDemandVoiceManager.endTransmission(channelId);
  }, [channelId]);

  const muteReceiveAudio = useCallback((muted) => {
    if (!channelId) return;
    onDemandVoiceManager.muteReceiveAudio(channelId, muted);
  }, [channelId]);

  return {
    voiceState,
    isTransmitting,
    isConnected: voiceState !== VOICE_STATE.DISCONNECTED,
    isReceiving: voiceState === VOICE_STATE.RECEIVING,
    error,
    startTransmission,
    endTransmission,
    muteReceiveAudio,
    getRoom: () => onDemandVoiceManager.getRoom(channelId),
  };
}

export function useOnDemandPTT(channelId, identity, options = {}) {
  const { onTransmitStart, onTransmitEnd, onError } = options;
  const { startTransmission, endTransmission, muteReceiveAudio, getRoom } = useOnDemandVoice(channelId);
  const [pttState, setPttState] = useState(PTT_STATES.IDLE);
  const roomRef = useRef(null);
  const localTrackRef = useRef(null);

  useEffect(() => {
    const handleStateChange = async (newState, oldState) => {
      setPttState(newState);

      if (newState === PTT_STATES.ARMING) {
        muteReceiveAudio(true);
      } else if (newState === PTT_STATES.TRANSMITTING && oldState === PTT_STATES.ARMING) {
        try {
          roomRef.current = await startTransmission(identity);
          
          if (roomRef.current && roomRef.current.localParticipant) {
            const track = micPTTManager.getLocalTrack();
            if (track) {
              await roomRef.current.localParticipant.publishTrack(track, {
                name: 'microphone',
                source: 'microphone',
              });
              localTrackRef.current = track;
            }
          }
          
          onTransmitStart?.();
        } catch (err) {
          console.error('[useOnDemandPTT] Failed to start transmission:', err);
          onError?.(err);
          micPTTManager.forceRelease();
        }
      } else if (newState === PTT_STATES.IDLE && oldState === PTT_STATES.TRANSMITTING) {
        if (localTrackRef.current && roomRef.current?.localParticipant) {
          try {
            await roomRef.current.localParticipant.unpublishTrack(localTrackRef.current);
          } catch (err) {
            console.warn('[useOnDemandPTT] Failed to unpublish track:', err);
          }
        }
        
        localTrackRef.current = null;
        await endTransmission();
        muteReceiveAudio(false);
        onTransmitEnd?.();
      }
    };

    micPTTManager.onStateChange = handleStateChange;

    return () => {
      micPTTManager.onStateChange = null;
    };
  }, [channelId, identity, startTransmission, endTransmission, muteReceiveAudio, onTransmitStart, onTransmitEnd, onError]);

  const startPTT = useCallback(() => {
    if (!channelId || !identity) {
      console.error('[useOnDemandPTT] Cannot start PTT: missing channelId or identity');
      return false;
    }
    return micPTTManager.start();
  }, [channelId, identity]);

  const stopPTT = useCallback(() => {
    return micPTTManager.stop();
  }, []);

  return {
    pttState,
    isTransmitting: pttState === PTT_STATES.TRANSMITTING,
    isArming: pttState === PTT_STATES.ARMING,
    startPTT,
    stopPTT,
  };
}

export { VOICE_STATE };
