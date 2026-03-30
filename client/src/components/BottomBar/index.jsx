import { useCallback, useEffect, useRef, useState } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';
import { PTT_STATES } from '../../constants/pttStates.js';
import audioTransportManager from '../../audio/AudioTransportManager.js';
import toneEngine from '../../audio/toneEngine.js';
import toneTransmitter from '../../audio/ToneTransmitter.js';
import { playTalkPermitTone } from '../../lib/audioTones.js';
import { useSignalingContext } from '../../context/SignalingContext.jsx';
import formatChannelDisplay from '../../utils/formatChannelDisplay.js';

export default function BottomBar({ onPTTStart, onPTTEnd, onToneTransmit, identity = 'Dispatch', signalPttStart, signalPttEnd }) {
  const { 
    channels, 
    txChannelIds, 
    pttState, 
    setPttState,
    toggleClearAir,
    clearAirChannel,
    setClearAirChannel,
    getTxChannelNames 
  } = useDispatchStore();

  const { signalClearAirStart, signalClearAirEnd } = useSignalingContext();
  
  const [disabledTones, setDisabledTones] = useState({});
  const [toneTransmitting, setToneTransmitting] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const [pttError, setPttError] = useState(false);
  const pttErrorTimerRef = useRef(null);
  const [showClearAirModal, setShowClearAirModal] = useState(false);
  const [showClearAirConfirm, setShowClearAirConfirm] = useState(false);
  const [selectedClearAirChannelId, setSelectedClearAirChannelId] = useState(null);
  const clearAirAudioRoomRef = useRef(null);
  const pttRef = useRef(null);
  const gestureActiveRef = useRef(false);
  const mutedChannelsRef = useRef([]);

  const selectedChannelNames = getTxChannelNames();

  const flashPttError = useCallback(() => {
    setPttError(true);
    if (pttErrorTimerRef.current) clearTimeout(pttErrorTimerRef.current);
    pttErrorTimerRef.current = setTimeout(() => setPttError(false), 1500);
  }, []);

  useEffect(() => {
    return () => {
      if (pttErrorTimerRef.current) clearTimeout(pttErrorTimerRef.current);
    };
  }, []);

  useEffect(() => {
    toneEngine.onToneStart = (type) => {
      setDisabledTones(prev => ({ ...prev, [type]: true }));
    };
    toneEngine.onToneEnd = (type) => {
      setDisabledTones(prev => ({ ...prev, [type]: false }));
    };

    audioTransportManager.onStateChange = (newState) => {
      setPttState(newState);
    };

    // Handle disconnect during transmission
    audioTransportManager.onDisconnectDuringTx = () => {
      console.warn('[BottomBar] Disconnect during transmission detected');
      toneEngine.playErrorTone();
      // Reset gesture state since transmission was force-released
      gestureActiveRef.current = false;
      // Unmute channels
      if (mutedChannelsRef.current.length > 0) {
        audioTransportManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
      }
    };

    return () => {
      toneEngine.onToneStart = null;
      toneEngine.onToneEnd = null;
      audioTransportManager.onStateChange = null;
      audioTransportManager.onDisconnectDuringTx = null;
    };
  }, [setPttState]);

  const startTransmission = useCallback(async () => {
    console.log('[PTT] startTransmission called, channels:', selectedChannelNames);
    if (selectedChannelNames.length === 0) return false;
    
    const isDispatcher = audioTransportManager.isDispatcherMode();
    if (!audioTransportManager.areChannelsHealthy(selectedChannelNames, { allowReconnecting: isDispatcher })) {
      console.warn('[PTT] Connection not healthy, blocking transmission');
      const status = audioTransportManager.getConnectionStatus();
      console.log('[PTT] Connection status:', status);
      toneEngine.playErrorTone?.();
      flashPttError();
      return false;
    }
    
    const isBusy = audioTransportManager.areAnyChannelsBusy(selectedChannelNames);
    
    if (isBusy) {
      console.log('[PTT] Channel busy, playing busy tone');
      setChannelBusy(true);
      console.log('[PTT] PTT_TONE_START', { reason: 'CHANNEL_BUSY' });
      toneEngine.startBusyTone();
      return false;
    }
    
    try {
      mutedChannelsRef.current = [...selectedChannelNames];
      audioTransportManager.muteChannels(mutedChannelsRef.current);
      
      const primaryChannel = selectedChannelNames[0];
      let room = audioTransportManager.getRoom(primaryChannel);
      
      if (!room && isDispatcher && audioTransportManager.isChannelReconnecting(primaryChannel)) {
        console.log('[PTT] Room not ready, waiting for reconnect...');
        try {
          room = await audioTransportManager.waitForRoom(primaryChannel, 5000);
          console.log('[PTT] Room became available after reconnect');
        } catch (waitErr) {
          console.error('[PTT] Timed out waiting for room reconnect:', waitErr.message);
          toneEngine.playErrorTone?.();
          flashPttError();
          audioTransportManager.unmuteChannels(mutedChannelsRef.current);
          mutedChannelsRef.current = [];
          return false;
        }
      }
      
      if (!room) {
        console.error('[PTT] No room for primary channel:', primaryChannel);
        toneEngine.playErrorTone?.();
        flashPttError();
        audioTransportManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
        return false;
      }

      audioTransportManager.setCurrentChannel(primaryChannel);
      audioTransportManager.setCurrentUnit(identity);
      audioTransportManager.setRoom(room);
      audioTransportManager.setPrimaryTxChannel(primaryChannel);
      
      if (signalPttStart) {
        try {
          console.log(`[PTT] Requesting floor grant for channel=${primaryChannel} unit=${identity}`);
          console.log('[PTT] PTT_FLOOR_REQUEST_SENT', { channel: primaryChannel, unit: identity });
          await signalPttStart(primaryChannel);
          console.log(`[PTT] Floor granted for channel=${primaryChannel}`);
          console.log('[PTT] PTT_FLOOR_GRANTED', { channel: primaryChannel, unit: identity });
        } catch (grantErr) {
          console.warn('[PTT] Floor denied:', grantErr.message);
          audioTransportManager.unmuteChannels(mutedChannelsRef.current);
          mutedChannelsRef.current = [];
          setChannelBusy(true);
          console.log('[PTT] PTT_TONE_START', { reason: 'FLOOR_DENIED' });
          toneEngine.startBusyTone();
          return false;
        }
      }
      
      try {
        console.log('[PTT] Playing talk permit tone before mic goes live');
        await playTalkPermitTone();
        console.log('[PTT] Talk permit tone finished, opening mic');
      } catch (toneErr) {
        console.warn('[PTT] Talk permit tone failed, proceeding anyway:', toneErr.message);
      }
      
      if (!gestureActiveRef.current) {
        console.log('[PTT] PTT released during tone playback, aborting');
        audioTransportManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
        return false;
      }
      
      const success = await audioTransportManager.start();
      
      if (!success) {
        console.warn('[PTT] audioTransportManager.start() returned false');
        toneEngine.playErrorTone?.();
        flashPttError();
        audioTransportManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
        return false;
      }
      
      console.log('[PTT] Transmission started successfully');
      
      return true;
    } catch (err) {
      console.error('[PTT] Failed to start transmission:', err);
      toneEngine.playErrorTone?.();
      flashPttError();
      audioTransportManager.unmuteChannels(mutedChannelsRef.current);
      mutedChannelsRef.current = [];
      return false;
    }
  }, [selectedChannelNames, identity, signalPttStart, flashPttError]);

  const stopTransmission = useCallback(async () => {
    console.log('[PTT] stopTransmission called');
    
    if (channelBusy) {
      console.log('[PTT] Was in busy mode, clearing');
      setChannelBusy(false);
      toneEngine.stopBusyTone();
      return;
    }
    
    const channelsToUnmute = [...mutedChannelsRef.current];
    const primaryChannel = selectedChannelNames[0];
    
    try {
      await audioTransportManager.stop();
      console.log('[PTT] Transmission stopped');
      
      if (signalPttEnd && primaryChannel) {
        signalPttEnd(primaryChannel);
      }
    } catch (err) {
      console.error('[PTT] Failed to stop transmission:', err);
      audioTransportManager.forceRelease();
    } finally {
      if (channelsToUnmute.length > 0) {
        audioTransportManager.unmuteChannels(channelsToUnmute);
        console.log('[PTT] Unmuted channels:', channelsToUnmute);
      }
      mutedChannelsRef.current = [];
    }
  }, [channelBusy, selectedChannelNames, signalPttEnd]);

  const handlePTTDown = useCallback(async (e) => {
    if (e.type === 'keydown' && e.repeat) return;
    if (txChannelIds.length === 0) return;
    if (gestureActiveRef.current) return;
    
    console.log('[PTT] PTT_DOWN', { eventType: e.type });
    gestureActiveRef.current = true;
    console.log('[PTT] PTT_GESTURE_ACTIVE_TRUE');
    console.log('[PTT] PTT_START');
    
    const success = await startTransmission();
    
    if (!gestureActiveRef.current) {
      console.log('[PTT] Gesture released during setup, stopping');
      await stopTransmission();
      return;
    }
    
    if (success && onPTTStart) {
      onPTTStart(selectedChannelNames);
    }
  }, [txChannelIds, selectedChannelNames, onPTTStart, startTransmission, stopTransmission]);

  const handlePTTUp = useCallback(async () => {
    console.log('[PTT] PTT_UP', { gestureActive: gestureActiveRef.current });
    if (!gestureActiveRef.current) return;
    
    console.log('[PTT] PTT_STOP');
    gestureActiveRef.current = false;
    console.log('[PTT] PTT_GESTURE_ACTIVE_FALSE');
    await stopTransmission();
    
    if (onPTTEnd) {
      onPTTEnd(selectedChannelNames);
    }
  }, [selectedChannelNames, onPTTEnd, stopTransmission]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space' && !e.repeat && e.target.tagName !== 'INPUT') {
        e.preventDefault();
        handlePTTDown(e);
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        handlePTTUp();
      }
    };

    const handleGlobalRelease = () => {
      if (gestureActiveRef.current) {
        handlePTTUp();
      }
    };

    const captureOptions = { capture: true, passive: false };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    document.addEventListener('pointerup', handleGlobalRelease, captureOptions);
    document.addEventListener('pointercancel', handleGlobalRelease, captureOptions);
    document.addEventListener('touchend', handleGlobalRelease, captureOptions);
    document.addEventListener('touchcancel', handleGlobalRelease, captureOptions);
    window.addEventListener('blur', handleGlobalRelease);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      document.removeEventListener('pointerup', handleGlobalRelease, captureOptions);
      document.removeEventListener('pointercancel', handleGlobalRelease, captureOptions);
      document.removeEventListener('touchend', handleGlobalRelease, captureOptions);
      document.removeEventListener('touchcancel', handleGlobalRelease, captureOptions);
      window.removeEventListener('blur', handleGlobalRelease);
    };
  }, [handlePTTDown, handlePTTUp]);

  const playToneWithTransmit = async (type, duration) => {
    if (disabledTones[type] || txChannelIds.length === 0) return;
    
    setToneTransmitting(true);
    
    const primaryChannel = selectedChannelNames[0];
    const room = audioTransportManager.getRoom(primaryChannel);
    
    if (!room) {
      console.error('[BottomBar] No room for tone transmission on channel:', primaryChannel);
      toneEngine.playEmergencyTone(type, duration);
      await new Promise(resolve => setTimeout(resolve, duration + 100));
      setToneTransmitting(false);
      return;
    }
    
    mutedChannelsRef.current = [...selectedChannelNames];
    audioTransportManager.muteChannels(mutedChannelsRef.current);
    
    if (signalPttStart) {
      try {
        await signalPttStart(primaryChannel);
      } catch (grantErr) {
        console.warn('[BottomBar] Tone floor denied:', grantErr.message);
        audioTransportManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
        toneEngine.startBusyTone();
        setTimeout(() => toneEngine.stopBusyTone(), 1000);
        setToneTransmitting(false);
        return;
      }
    }
    
    try {
      if (onToneTransmit) {
        onToneTransmit(selectedChannelNames, type, duration);
      }
      
      toneTransmitter.setRoom(room);
      await toneTransmitter.transmitTone(type, duration);
    } finally {
      if (signalPttEnd) {
        signalPttEnd(primaryChannel);
      }
      
      audioTransportManager.unmuteChannels(mutedChannelsRef.current);
      mutedChannelsRef.current = [];
      
      setToneTransmitting(false);
    }
  };

  const isClearAirActive = !!clearAirChannel;

  const handleClearAirToggle = () => {
    if (isClearAirActive) {
      setShowClearAirConfirm(true);
    } else {
      const firstTxId = txChannelIds[0] || null;
      setSelectedClearAirChannelId(firstTxId);
      setShowClearAirModal(true);
    }
  };

  const handleClearAirConfirmStart = async () => {
    if (!selectedClearAirChannelId) return;
    const channelId = String(selectedClearAirChannelId);
    const channel = channels.find(ch => String(ch.id) === channelId);
    const roomKey = channel ? (channel.room_key || ((channel.zone || 'Default') + '__' + channel.name)) : null;
    
    setShowClearAirModal(false);
    
    if (roomKey) {
      const wasAlreadyConnected = audioTransportManager.isConnected(roomKey);
      if (!wasAlreadyConnected) {
        clearAirAudioRoomRef.current = roomKey;
        try {
          await audioTransportManager.connect(roomKey, identity);
        } catch (err) {
          console.warn('[BottomBar] ClearAir audio transport connect failed:', err);
          clearAirAudioRoomRef.current = null;
          return;
        }
      } else {
        clearAirAudioRoomRef.current = null;
      }

      if (signalPttStart) {
        try {
          await signalPttStart(roomKey);
        } catch (grantErr) {
          console.warn('[BottomBar] Clear Air floor denied:', grantErr.message);
          toneEngine.startBusyTone();
          setTimeout(() => toneEngine.stopBusyTone(), 1000);
          if (clearAirAudioRoomRef.current === roomKey) {
            clearAirAudioRoomRef.current = null;
            audioTransportManager.disconnect(roomKey).catch(() => {});
          }
          return;
        }
      }

      const room = audioTransportManager.getRoom(roomKey);
      if (room) {
        toneTransmitter.setRoom(room);
        const started = await toneTransmitter.startToneTransmission();
        if (started) {
          console.log('[BottomBar] Clear Air tone broadcasting over air on', roomKey);
        } else {
          if (signalPttEnd) signalPttEnd(roomKey);
          if (clearAirAudioRoomRef.current === roomKey) {
            clearAirAudioRoomRef.current = null;
            audioTransportManager.disconnect(roomKey).catch(() => {});
          }
          return;
        }
      } else {
        console.warn('[BottomBar] No room available for Clear Air on', roomKey);
        if (signalPttEnd) signalPttEnd(roomKey);
        if (clearAirAudioRoomRef.current === roomKey) {
          clearAirAudioRoomRef.current = null;
          audioTransportManager.disconnect(roomKey).catch(() => {});
        }
        return;
      }

      toggleClearAir(channelId);
      setClearAirChannel(channelId);
      toneEngine.startClearAir(channelId);
      signalClearAirStart(roomKey);
    }
  };

  const handleClearAirConfirmEnd = () => {
    if (!clearAirChannel) return;
    const channelId = String(clearAirChannel);
    const channel = channels.find(ch => String(ch.id) === channelId);
    const roomKey = channel ? (channel.room_key || ((channel.zone || 'Default') + '__' + channel.name)) : null;
    
    toggleClearAir(channelId);
    setClearAirChannel(null);
    setShowClearAirConfirm(false);
    
    if (roomKey) {
      toneEngine.stopClearAir(channelId);
      toneTransmitter.stopToneTransmission().catch(err => {
        console.warn('[BottomBar] ClearAir tone stop failed:', err);
      });
      if (signalPttEnd) {
        signalPttEnd(roomKey);
      }
      signalClearAirEnd(roomKey);
      const ownedRoom = clearAirAudioRoomRef.current;
      if (ownedRoom === roomKey) {
        clearAirAudioRoomRef.current = null;
        audioTransportManager.disconnect(roomKey).catch(err => {
          console.warn('[BottomBar] ClearAir audio transport disconnect failed:', err);
        });
      }
    }
  };

  const activeClearAirChannel = clearAirChannel
    ? channels.find(ch => String(ch.id) === String(clearAirChannel))
    : null;
  const activeClearAirChannelName = activeClearAirChannel
    ? formatChannelDisplay(activeClearAirChannel.zone, activeClearAirChannel.name)
    : '';

  const hasTxChannels = txChannelIds.length > 0;
  const isTransmitting = pttState === PTT_STATES.TRANSMITTING || 
                         pttState === PTT_STATES.ARMING || 
                         toneTransmitting;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-dispatch-panel border-t border-dispatch-border">
      <div className="flex items-center gap-3">
        <button
          ref={pttRef}
          onPointerDown={handlePTTDown}
          onPointerUp={handlePTTUp}
          onPointerCancel={handlePTTUp}
          onMouseDown={handlePTTDown}
          onMouseUp={handlePTTUp}
          onMouseLeave={handlePTTUp}
          onTouchStart={handlePTTDown}
          onTouchEnd={handlePTTUp}
          disabled={!hasTxChannels || toneTransmitting}
          className={`px-8 py-3 rounded-lg font-bold text-lg transition-all select-none ${
            pttError
              ? 'bg-orange-600 text-white ring-4 ring-orange-400 animate-pulse'
              : isTransmitting
                ? 'bg-red-600 text-white ring-4 ring-red-400' 
                : hasTxChannels 
                  ? 'bg-green-600 hover:bg-green-700 text-white' 
                  : 'bg-dispatch-border text-dispatch-secondary cursor-not-allowed'
          }`}
        >
          {pttError ? 'PTT FAILED' : isTransmitting ? 'TRANSMITTING' : 'PTT (SPACE)'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => playToneWithTransmit('A', 2500)}
          disabled={disabledTones['A'] || !hasTxChannels || toneTransmitting}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['A'] || !hasTxChannels || toneTransmitting
              ? 'bg-dispatch-border text-dispatch-secondary cursor-not-allowed'
              : 'bg-yellow-600 hover:bg-yellow-700 text-white'
          }`}
        >
          Alert
        </button>
        <button
          onClick={() => playToneWithTransmit('B', 2000)}
          disabled={disabledTones['B'] || !hasTxChannels || toneTransmitting}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['B'] || !hasTxChannels || toneTransmitting
              ? 'bg-dispatch-border text-dispatch-secondary cursor-not-allowed'
              : 'bg-orange-600 hover:bg-orange-700 text-white'
          }`}
        >
          MDC
        </button>
        <button
          onClick={() => playToneWithTransmit('C', 3000)}
          disabled={disabledTones['C'] || !hasTxChannels || toneTransmitting}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['C'] || !hasTxChannels || toneTransmitting
              ? 'bg-dispatch-border text-dispatch-secondary cursor-not-allowed'
              : 'bg-amber-600 hover:bg-amber-700 text-white'
          }`}
        >
          Pre-Alert
        </button>
        <button
          onClick={() => playToneWithTransmit('CONTINUOUS', 5000)}
          disabled={disabledTones['CONTINUOUS'] || !hasTxChannels || toneTransmitting}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['CONTINUOUS'] || !hasTxChannels || toneTransmitting
              ? 'bg-dispatch-border text-dispatch-secondary cursor-not-allowed'
              : 'bg-red-600 hover:bg-red-700 text-white'
          }`}
        >
          Continuous
        </button>
        <button
          onClick={handleClearAirToggle}
          disabled={!hasTxChannels && !isClearAirActive}
          className={`px-3 py-1.5 text-sm rounded transition-colors font-medium ${
            isClearAirActive
              ? 'bg-blue-600 text-white animate-pulse'
              : 'bg-dispatch-border hover:bg-dispatch-panel text-dispatch-text'
          } ${(!hasTxChannels && !isClearAirActive) ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {isClearAirActive
            ? `CLEAR AIR: ${activeClearAirChannelName}`
            : 'Clear-Air OFF'}
        </button>
      </div>

      {showClearAirModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowClearAirModal(false)}>
          <div className="bg-dispatch-panel border border-dispatch-border rounded-lg p-6 w-80 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-bold text-lg mb-1">Activate Clear Air</h2>
            <p className="text-dispatch-secondary text-sm mb-4">Select channel to clear for emergency traffic only.</p>
            <label className="text-xs text-dispatch-secondary uppercase tracking-wider mb-1 block">Channel</label>
            <select
              value={selectedClearAirChannelId || ''}
              onChange={e => setSelectedClearAirChannelId(e.target.value || null)}
              className="w-full bg-dispatch-bg border border-dispatch-border text-white rounded px-3 py-2 mb-4 text-sm"
            >
              {channels.map(ch => (
                <option key={ch.id} value={ch.id}>{formatChannelDisplay(ch.zone, ch.name)}</option>
              ))}
            </select>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowClearAirModal(false)}
                className="px-4 py-2 rounded text-sm text-dispatch-secondary hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleClearAirConfirmStart}
                disabled={!selectedClearAirChannelId}
                className="px-4 py-2 rounded text-sm bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50"
              >
                Activate Clear Air
              </button>
            </div>
          </div>
        </div>
      )}

      {showClearAirConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setShowClearAirConfirm(false)}>
          <div className="bg-dispatch-panel border border-dispatch-border rounded-lg p-6 w-80 shadow-xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-white font-bold text-lg mb-2">Release Emergency Traffic?</h2>
            <p className="text-dispatch-secondary text-sm mb-4">
              Are you sure you want to release emergency traffic on <strong className="text-white">{activeClearAirChannelName}</strong>? Units will be disconnected from the forced channel.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setShowClearAirConfirm(false)}
                className="px-4 py-2 rounded text-sm text-dispatch-secondary hover:text-white transition-colors"
              >
                Keep Active
              </button>
              <button
                onClick={handleClearAirConfirmEnd}
                className="px-4 py-2 rounded text-sm bg-red-600 hover:bg-red-700 text-white font-semibold"
              >
                Release
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
