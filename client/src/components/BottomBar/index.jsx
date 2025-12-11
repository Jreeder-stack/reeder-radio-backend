import { useCallback, useEffect, useRef } from 'react';
import { useChannelStore } from '../../state/channels.js';
import { useDispatcherStore } from '../../state/dispatcher.js';
import toneEngine from '../../audio/toneEngine.js';

export default function BottomBar({ onPTTStart, onPTTEnd }) {
  const { channels, primaryTxChannelId, setPrimaryTxChannel } = useChannelStore();
  const { isTalking, setTalking, clearAirEnabled, toggleClearAir } = useDispatcherStore();
  const pttRef = useRef(null);

  const primaryChannel = channels.find(c => c.id === primaryTxChannelId);

  const handlePTTDown = useCallback((e) => {
    if (e.type === 'keydown' && e.repeat) return;
    if (!primaryTxChannelId) return;
    
    setTalking(true);
    if (onPTTStart) onPTTStart(primaryChannel?.name || primaryTxChannelId);
  }, [primaryTxChannelId, primaryChannel, setTalking, onPTTStart]);

  const handlePTTUp = useCallback(() => {
    setTalking(false);
    if (onPTTEnd) onPTTEnd();
  }, [setTalking, onPTTEnd]);

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

  const playTone = (type) => {
    toneEngine.playEmergencyTone(type, 2000);
  };

  const handleClearAirToggle = () => {
    if (primaryTxChannelId) {
      toggleClearAir(primaryTxChannelId);
      if (!clearAirEnabled[primaryTxChannelId]) {
        toneEngine.startClearAir(primaryTxChannelId);
      } else {
        toneEngine.stopClearAir(primaryTxChannelId);
      }
    }
  };

  return (
    <div className="flex items-center justify-between px-4 py-3 bg-dispatch-panel border-t border-dispatch-border">
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">TX Channel:</span>
          <select
            value={primaryTxChannelId || ''}
            onChange={(e) => setPrimaryTxChannel(e.target.value ? parseInt(e.target.value) : null)}
            className="px-3 py-1.5 bg-gray-800 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-blue-500"
          >
            <option value="">Select Channel</option>
            {channels.map(ch => (
              <option key={ch.id} value={ch.id}>{ch.name}</option>
            ))}
          </select>
        </div>

        {primaryChannel && (
          <div className="px-3 py-1 bg-blue-900 rounded text-blue-200 text-sm font-medium">
            {primaryChannel.name}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          ref={pttRef}
          onMouseDown={handlePTTDown}
          onMouseUp={handlePTTUp}
          onMouseLeave={handlePTTUp}
          onTouchStart={handlePTTDown}
          onTouchEnd={handlePTTUp}
          disabled={!primaryTxChannelId}
          className={`px-8 py-3 rounded-lg font-bold text-lg transition-all select-none ${
            isTalking 
              ? 'bg-red-600 text-white ring-4 ring-red-400' 
              : primaryTxChannelId 
                ? 'bg-green-600 hover:bg-green-700 text-white' 
                : 'bg-gray-600 text-gray-400 cursor-not-allowed'
          }`}
        >
          {isTalking ? 'TRANSMITTING' : 'PTT (SPACE)'}
        </button>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => playTone('A')}
          className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-700 text-white text-sm rounded transition-colors"
        >
          Tone A
        </button>
        <button
          onClick={() => playTone('B')}
          className="px-3 py-1.5 bg-orange-600 hover:bg-orange-700 text-white text-sm rounded transition-colors"
        >
          Tone B
        </button>
        <button
          onClick={() => playTone('C')}
          className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
        >
          Tone C
        </button>
        <button
          onClick={handleClearAirToggle}
          disabled={!primaryTxChannelId}
          className={`px-3 py-1.5 text-sm rounded transition-colors ${
            clearAirEnabled[primaryTxChannelId]
              ? 'bg-blue-600 text-white'
              : 'bg-gray-600 hover:bg-gray-700 text-white'
          } ${!primaryTxChannelId ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          Clear-Air {clearAirEnabled[primaryTxChannelId] ? 'ON' : 'OFF'}
        </button>
      </div>
    </div>
  );
}
