import { useCallback, useEffect, useRef, useState } from 'react';
import { useChannelStore } from '../../state/channels.js';
import { useDispatcherStore } from '../../state/dispatcher.js';
import toneEngine from '../../audio/toneEngine.js';
import livekitEngine from '../../audio/livekitEngine.js';

export default function BottomBar({ onPTTStart, onPTTEnd, onToneTransmit }) {
  const { channels, selectedTxChannels } = useChannelStore();
  const { isTalking, setTalking, clearAirEnabled, toggleClearAir } = useDispatcherStore();
  const [disabledTones, setDisabledTones] = useState({});
  const [toneTransmitting, setToneTransmitting] = useState(false);
  const pttRef = useRef(null);
  const pttActiveRef = useRef(false);

  const selectedChannelNames = selectedTxChannels
    .map(id => channels.find(c => c.id === id)?.name)
    .filter(Boolean);

  useEffect(() => {
    toneEngine.onToneStart = (type) => {
      setDisabledTones(prev => ({ ...prev, [type]: true }));
    };
    toneEngine.onToneEnd = (type) => {
      setDisabledTones(prev => ({ ...prev, [type]: false }));
    };
    return () => {
      toneEngine.onToneStart = null;
      toneEngine.onToneEnd = null;
    };
  }, []);

  const startTransmission = useCallback(async () => {
    if (selectedChannelNames.length === 0) return false;
    
    try {
      await livekitEngine.publishAudioToChannels(selectedChannelNames);
      
      const txContext = livekitEngine.getTxContext();
      const toneDestination = livekitEngine.getToneDestination();
      
      if (txContext && toneDestination) {
        toneEngine.setTxMode(txContext, toneDestination);
      }
      
      return true;
    } catch (err) {
      console.error('Failed to start transmission:', err);
      return false;
    }
  }, [selectedChannelNames]);

  const stopTransmission = useCallback(async () => {
    try {
      toneEngine.clearTxMode();
      await livekitEngine.unpublishAudioFromChannels(selectedChannelNames);
    } catch (err) {
      console.error('Failed to stop transmission:', err);
    }
  }, [selectedChannelNames]);

  const handlePTTDown = useCallback(async (e) => {
    if (e.type === 'keydown' && e.repeat) return;
    if (selectedTxChannels.length === 0) return;
    if (pttActiveRef.current) return;
    
    pttActiveRef.current = true;
    setTalking(true);
    
    await startTransmission();
    
    if (onPTTStart) onPTTStart(selectedChannelNames);
  }, [selectedTxChannels, selectedChannelNames, setTalking, onPTTStart, startTransmission]);

  const handlePTTUp = useCallback(async () => {
    if (!pttActiveRef.current) return;
    
    pttActiveRef.current = false;
    setTalking(false);
    
    await stopTransmission();
    
    if (onPTTEnd) onPTTEnd(selectedChannelNames);
  }, [selectedChannelNames, setTalking, onPTTEnd, stopTransmission]);

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

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [handlePTTDown, handlePTTUp]);

  const playToneWithTransmit = async (type, duration) => {
    if (disabledTones[type] || selectedTxChannels.length === 0) return;
    
    setToneTransmitting(true);
    
    const wasAlreadyTransmitting = pttActiveRef.current;
    
    if (!wasAlreadyTransmitting) {
      pttActiveRef.current = true;
      setTalking(true);
      await startTransmission();
    }
    
    if (onToneTransmit) {
      onToneTransmit(selectedChannelNames, type, duration);
    }
    
    toneEngine.playEmergencyTone(type, duration);
    
    const waitForTone = () => {
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (!toneEngine.isTonePlaying(type)) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);
        
        setTimeout(() => {
          clearInterval(checkInterval);
          resolve();
        }, duration + 500);
      });
    };
    
    await waitForTone();
    
    if (!wasAlreadyTransmitting) {
      pttActiveRef.current = false;
      setTalking(false);
      await stopTransmission();
    }
    
    setToneTransmitting(false);
  };

  const handleClearAirToggle = () => {
    if (selectedTxChannels.length > 0) {
      const channelId = selectedTxChannels[0];
      toggleClearAir(channelId);
      if (!clearAirEnabled[channelId]) {
        toneEngine.startClearAir(channelId);
      } else {
        toneEngine.stopClearAir(channelId);
      }
    }
  };

  const hasTxChannels = selectedTxChannels.length > 0;
  const firstTxChannelId = selectedTxChannels[0];
  const isTransmitting = isTalking || toneTransmitting;

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-dispatch-panel border-t border-dispatch-border">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">TX Channels:</span>
          {selectedTxChannels.length > 0 ? (
            <div className="flex flex-wrap gap-1 max-w-xs">
              {selectedChannelNames.slice(0, 4).map(name => (
                <span key={name} className="px-2 py-0.5 bg-blue-900 rounded text-blue-200 text-xs font-medium">
                  {name}
                </span>
              ))}
              {selectedChannelNames.length > 4 && (
                <span className="px-2 py-0.5 bg-gray-700 rounded text-gray-300 text-xs">
                  +{selectedChannelNames.length - 4} more
                </span>
              )}
            </div>
          ) : (
            <span className="text-xs text-gray-500">None selected</span>
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
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isTransmitting ? 'TRANSMITTING' : 'PTT (SPACE)'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => playToneWithTransmit('A', 1000)}
          disabled={disabledTones['A'] || !hasTxChannels || toneTransmitting}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['A'] || !hasTxChannels || toneTransmitting
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
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
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-orange-600 hover:bg-orange-700 text-white'
          }`}
        >
          MDC
        </button>
        <button
          onClick={() => playToneWithTransmit('C', 2500)}
          disabled={disabledTones['C'] || !hasTxChannels || toneTransmitting}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['C'] || !hasTxChannels || toneTransmitting
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
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
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
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
              : 'bg-gray-600 hover:bg-gray-700 text-white'
          } ${!hasTxChannels ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          Clear-Air {clearAirEnabled[firstTxChannelId] ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}
