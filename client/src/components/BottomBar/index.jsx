import { useCallback, useEffect, useRef, useState } from 'react';
import { useChannelStore } from '../../state/channels.js';
import { useDispatcherStore } from '../../state/dispatcher.js';
import toneEngine from '../../audio/toneEngine.js';

export default function BottomBar({ onPTTStart, onPTTEnd, onToneTransmit }) {
  const { channels, selectedTxChannels } = useChannelStore();
  const { isTalking, setTalking, clearAirEnabled, toggleClearAir } = useDispatcherStore();
  const [disabledTones, setDisabledTones] = useState({});
  const pttRef = useRef(null);

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

  const handlePTTDown = useCallback((e) => {
    if (e.type === 'keydown' && e.repeat) return;
    if (selectedTxChannels.length === 0) return;
    
    setTalking(true);
    if (onPTTStart) onPTTStart(selectedChannelNames);
  }, [selectedTxChannels, selectedChannelNames, setTalking, onPTTStart]);

  const handlePTTUp = useCallback(() => {
    setTalking(false);
    if (onPTTEnd) onPTTEnd(selectedChannelNames);
  }, [selectedChannelNames, setTalking, onPTTEnd]);

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

  const playTone = async (type, duration) => {
    if (disabledTones[type] || selectedTxChannels.length === 0) return;
    
    if (onToneTransmit) {
      await onToneTransmit(selectedChannelNames, type, duration);
    }
    
    toneEngine.playEmergencyTone(type, duration);
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
          disabled={!hasTxChannels}
          className={`px-8 py-3 rounded-lg font-bold text-lg transition-all select-none ${
            isTalking 
              ? 'bg-red-600 text-white ring-4 ring-red-400' 
              : hasTxChannels 
                ? 'bg-green-600 hover:bg-green-700 text-white' 
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isTalking ? 'TRANSMITTING' : 'PTT (SPACE)'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => playTone('A', 1000)}
          disabled={disabledTones['A'] || !hasTxChannels}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['A'] || !hasTxChannels
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-yellow-600 hover:bg-yellow-700 text-white'
          }`}
        >
          Alert
        </button>
        <button
          onClick={() => playTone('B', 2000)}
          disabled={disabledTones['B'] || !hasTxChannels}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['B'] || !hasTxChannels
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-orange-600 hover:bg-orange-700 text-white'
          }`}
        >
          MDC
        </button>
        <button
          onClick={() => playTone('C', 1500)}
          disabled={disabledTones['C'] || !hasTxChannels}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['C'] || !hasTxChannels
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-amber-600 hover:bg-amber-700 text-white'
          }`}
        >
          Pre-Alert
        </button>
        <button
          onClick={() => playTone('CONTINUOUS', 5000)}
          disabled={disabledTones['CONTINUOUS'] || !hasTxChannels}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            disabledTones['CONTINUOUS'] || !hasTxChannels
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
