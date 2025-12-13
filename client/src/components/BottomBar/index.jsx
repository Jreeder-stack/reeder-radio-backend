import { useCallback, useEffect, useRef, useState } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';
import { micPTTManager } from '../../audio/MicPTTManager.js';
import { PTT_STATES } from '../../constants/pttStates.js';
import livekitManager from '../../audio/LiveKitManager.js';
import toneEngine from '../../audio/toneEngine.js';
import toneTransmitter from '../../audio/ToneTransmitter.js';

export default function BottomBar({ onPTTStart, onPTTEnd, onToneTransmit }) {
  const { 
    channels, 
    txChannelIds, 
    pttState, 
    setPttState,
    clearAirEnabled, 
    toggleClearAir,
    getTxChannelNames 
  } = useDispatchStore();
  
  const [disabledTones, setDisabledTones] = useState({});
  const [toneTransmitting, setToneTransmitting] = useState(false);
  const [channelBusy, setChannelBusy] = useState(false);
  const pttRef = useRef(null);
  const gestureActiveRef = useRef(false);
  const mutedChannelsRef = useRef([]);

  const selectedChannelNames = getTxChannelNames();

  useEffect(() => {
    toneEngine.onToneStart = (type) => {
      setDisabledTones(prev => ({ ...prev, [type]: true }));
    };
    toneEngine.onToneEnd = (type) => {
      setDisabledTones(prev => ({ ...prev, [type]: false }));
    };

    micPTTManager.onStateChange = (newState) => {
      setPttState(newState);
    };

    return () => {
      toneEngine.onToneStart = null;
      toneEngine.onToneEnd = null;
      micPTTManager.onStateChange = null;
    };
  }, [setPttState]);

  const startTransmission = useCallback(async () => {
    console.log('[PTT] startTransmission called, channels:', selectedChannelNames);
    if (selectedChannelNames.length === 0) return false;
    
    const isBusy = livekitManager.areAnyChannelsBusy(selectedChannelNames);
    
    if (isBusy) {
      console.log('[PTT] Channel busy, playing busy tone');
      setChannelBusy(true);
      toneEngine.startBusyTone();
      return false;
    }
    
    try {
      mutedChannelsRef.current = [...selectedChannelNames];
      livekitManager.muteChannels(mutedChannelsRef.current);
      
      const primaryChannel = selectedChannelNames[0];
      const room = livekitManager.getRoom(primaryChannel);
      
      if (!room) {
        console.error('[PTT] No room for primary channel:', primaryChannel);
        livekitManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
        return false;
      }

      micPTTManager.setRoom(room);
      const success = await micPTTManager.start();
      
      if (!success) {
        livekitManager.unmuteChannels(mutedChannelsRef.current);
        mutedChannelsRef.current = [];
        return false;
      }
      
      // Note: MicPTTManager already plays permit tone - don't play duplicate
      console.log('[PTT] Transmission started successfully');
      
      return true;
    } catch (err) {
      console.error('[PTT] Failed to start transmission:', err);
      livekitManager.unmuteChannels(mutedChannelsRef.current);
      mutedChannelsRef.current = [];
      return false;
    }
  }, [selectedChannelNames]);

  const stopTransmission = useCallback(async () => {
    console.log('[PTT] stopTransmission called');
    
    if (channelBusy) {
      console.log('[PTT] Was in busy mode, clearing');
      setChannelBusy(false);
      toneEngine.stopBusyTone();
      return;
    }
    
    const channelsToUnmute = [...mutedChannelsRef.current];
    
    try {
      await micPTTManager.stop();
      console.log('[PTT] Transmission stopped');
    } catch (err) {
      console.error('[PTT] Failed to stop transmission:', err);
      micPTTManager.forceRelease();
    } finally {
      if (channelsToUnmute.length > 0) {
        livekitManager.unmuteChannels(channelsToUnmute);
        console.log('[PTT] Unmuted channels:', channelsToUnmute);
      }
      mutedChannelsRef.current = [];
    }
  }, [channelBusy]);

  const handlePTTDown = useCallback(async (e) => {
    if (e.type === 'keydown' && e.repeat) return;
    if (txChannelIds.length === 0) return;
    if (gestureActiveRef.current) return;
    if (!micPTTManager.canStart()) return;
    
    console.log('[PTT] === PTT DOWN ===');
    gestureActiveRef.current = true;
    
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
    console.log('[PTT] === PTT UP ===, gestureActive:', gestureActiveRef.current);
    if (!gestureActiveRef.current) return;
    
    gestureActiveRef.current = false;
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
    const room = livekitManager.getRoom(primaryChannel);
    
    if (!room) {
      console.error('[BottomBar] No room for tone transmission on channel:', primaryChannel);
      toneEngine.playEmergencyTone(type, duration);
      await new Promise(resolve => setTimeout(resolve, duration + 100));
      setToneTransmitting(false);
      return;
    }
    
    mutedChannelsRef.current = [...selectedChannelNames];
    livekitManager.muteChannels(mutedChannelsRef.current);
    
    if (onToneTransmit) {
      onToneTransmit(selectedChannelNames, type, duration);
    }
    
    toneTransmitter.setRoom(room);
    await toneTransmitter.transmitTone(type, duration);
    
    livekitManager.unmuteChannels(mutedChannelsRef.current);
    mutedChannelsRef.current = [];
    
    setToneTransmitting(false);
  };

  const handleClearAirToggle = () => {
    if (txChannelIds.length > 0) {
      const channelId = txChannelIds[0];
      toggleClearAir(channelId);
      if (!clearAirEnabled[channelId]) {
        toneEngine.startClearAir(channelId);
      } else {
        toneEngine.stopClearAir(channelId);
      }
    }
  };

  const hasTxChannels = txChannelIds.length > 0;
  const firstTxChannelId = txChannelIds[0];
  const isTransmitting = pttState === PTT_STATES.TRANSMITTING || 
                         pttState === PTT_STATES.ARMING || 
                         toneTransmitting;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-dispatch-panel border-t border-dispatch-border">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-dispatch-secondary">TX Channels:</span>
          {txChannelIds.length > 0 ? (
            <div className="flex flex-wrap gap-1 max-w-xs">
              {selectedChannelNames.slice(0, 4).map(name => (
                <span key={name} className="px-2 py-0.5 bg-blue-600 rounded text-white text-xs font-medium">
                  {name}
                </span>
              ))}
              {selectedChannelNames.length > 4 && (
                <span className="px-2 py-0.5 bg-dispatch-border rounded text-dispatch-secondary text-xs">
                  +{selectedChannelNames.length - 4} more
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-dispatch-secondary">None selected</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          ref={pttRef}
          onMouseDown={handlePTTDown}
          onMouseUp={handlePTTUp}
          onMouseLeave={handlePTTUp}
          onTouchStart={handlePTTDown}
          onTouchEnd={handlePTTUp}
          disabled={!hasTxChannels || toneTransmitting}
          className={`px-8 py-3 rounded-lg font-bold text-lg transition-all select-none ${
            isTransmitting
              ? 'bg-red-600 text-white ring-4 ring-red-400' 
              : hasTxChannels 
                ? 'bg-green-600 hover:bg-green-700 text-white' 
                : 'bg-dispatch-border text-dispatch-secondary cursor-not-allowed'
          }`}
        >
          {isTransmitting ? 'TRANSMITTING' : 'PTT (SPACE)'}
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
          disabled={!hasTxChannels}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            clearAirEnabled[firstTxChannelId]
              ? 'bg-blue-600 text-white'
              : 'bg-dispatch-border hover:bg-dispatch-panel text-dispatch-text'
          } ${!hasTxChannels ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          Clear-Air {clearAirEnabled[firstTxChannelId] ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}
