import { useState, useEffect, useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import useDispatchStore from '../../state/dispatchStore.js';
import audioTransportManager from '../../audio/AudioTransportManager.js';
import { PTT_STATES } from '../../constants/pttStates.js';
import { useAuth } from '../../AuthContext.jsx';

const SIGNAL_QUALITY_LEVELS = {
  EXCELLENT: { bars: 4, color: 'bg-green-400', label: 'Excellent' },
  GOOD: { bars: 3, color: 'bg-green-400', label: 'Good' },
  FAIR: { bars: 2, color: 'bg-yellow-400', label: 'Fair' },
  POOR: { bars: 1, color: 'bg-red-400', label: 'Poor' },
  NONE: { bars: 0, color: 'bg-gray-500', label: 'No signal' },
};

function SignalBars({ quality, lossPct, jitterMs }) {
  const info = SIGNAL_QUALITY_LEVELS[quality] || SIGNAL_QUALITY_LEVELS.NONE;
  const tooltip = `Link: ${info.label} (loss ${Number(lossPct ?? 0).toFixed(1)}% / jitter ${Number(jitterMs ?? 0).toFixed(0)}ms)`;
  return (
    <span
      className="inline-flex items-end gap-0.5 ml-1 align-middle"
      title={tooltip}
      aria-label={tooltip}
    >
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`w-1 rounded-sm ${i <= info.bars ? info.color : 'bg-gray-700 opacity-50'}`}
          style={{ height: `${4 + i * 2}px` }}
        />
      ))}
    </span>
  );
}

function ConnectionStatusIndicator({ roomKey, isMonitored }) {
  const [connState, setConnState] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [showError, setShowError] = useState(false);
  const tooltipRef = useRef(null);
  const latchedErrorRef = useRef(null);

  useEffect(() => {
    if (!isMonitored || !roomKey) {
      setConnState(null);
      setErrorMsg(null);
      setShowError(false);
      latchedErrorRef.current = null;
      return;
    }

    setConnState(null);
    setErrorMsg(null);
    setShowError(false);
    latchedErrorRef.current = null;

    const status = audioTransportManager.getConnectionStatus();
    const chStatus = status.channels.find(c => c.channel === roomKey);
    if (chStatus) {
      if (chStatus.state === 'connected') {
        setConnState('connected');
      } else if (chStatus.error) {
        latchedErrorRef.current = chStatus.error;
        setConnState('error');
        setErrorMsg(chStatus.error);
      } else {
        setConnState('reconnecting');
      }
    }

    const removeListener = audioTransportManager.addConnectionStateChangeListener((channelName, state, error) => {
      if (channelName !== roomKey) return;
      if (state === 'connected') {
        setConnState('connected');
        latchedErrorRef.current = null;
        setErrorMsg(null);
        setShowError(false);
      } else if (error) {
        const msg = typeof error === 'string' ? error : error?.message || 'Connection failed';
        latchedErrorRef.current = msg;
        setConnState('error');
        setErrorMsg(msg);
      } else if (latchedErrorRef.current) {
        setConnState('error');
        setErrorMsg(latchedErrorRef.current);
      } else {
        setConnState('reconnecting');
      }
    });

    const removeHealthListener = audioTransportManager.addHealthChangeListener((channelName, health) => {
      if (channelName !== roomKey) return;
      const s = audioTransportManager.getConnectionStatus();
      const ch = s.channels.find(c => c.channel === roomKey);
      if (ch) {
        if (ch.state === 'connected') {
          setConnState('connected');
          latchedErrorRef.current = null;
          setErrorMsg(null);
          setShowError(false);
        } else if (ch.error || latchedErrorRef.current) {
          if (ch.error) latchedErrorRef.current = ch.error;
          setConnState('error');
          setErrorMsg(latchedErrorRef.current);
        } else {
          setConnState('reconnecting');
        }
      }
    });

    return () => {
      removeListener();
      removeHealthListener();
    };
  }, [roomKey, isMonitored]);

  useEffect(() => {
    if (!showError) return;
    const handleClickOutside = (e) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target)) {
        setShowError(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showError]);

  if (!isMonitored || !connState) return null;

  const handleErrorClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    setShowError(prev => !prev);
  };

  if (connState === 'connected') {
    return (
      <span title="Connected" className="inline-flex items-center text-green-500">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </span>
    );
  }

  if (connState === 'reconnecting') {
    return (
      <span title="Connecting..." className="inline-flex items-center text-yellow-500">
        <svg className="w-3.5 h-3.5 animate-pulse" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="6" />
        </svg>
      </span>
    );
  }

  if (connState === 'error') {
    return (
      <span className="relative inline-flex items-center" ref={tooltipRef}>
        <button
          type="button"
          onClick={handleErrorClick}
          onPointerDown={(e) => e.stopPropagation()}
          className="inline-flex items-center text-red-500 hover:text-red-400 cursor-pointer"
          title="Connection error — click for details"
          aria-label="Connection error details"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        {showError && errorMsg && (
          <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs text-white bg-gray-900 border border-red-500/50 rounded-lg shadow-lg whitespace-nowrap max-w-[200px] text-center" style={{ whiteSpace: 'normal', wordBreak: 'break-word' }}>
            <div className="font-semibold text-red-400 mb-0.5">Connection Error</div>
            {errorMsg}
            <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px">
              <div className="w-2 h-2 bg-gray-900 border-r border-b border-red-500/50 rotate-45" />
            </div>
          </div>
        )}
      </span>
    );
  }

  return null;
}

function AudioLevelMeter({ level }) {
  const barCount = 8;
  const activeCount = Math.round((level / 100) * barCount);
  
  return (
    <div className="flex gap-0.5 items-end h-4">
      {Array.from({ length: barCount }).map((_, i) => (
        <div
          key={i}
          className={`w-1 rounded-sm transition-all ${
            i < activeCount 
              ? i >= 6 ? 'bg-red-500' : i >= 4 ? 'bg-yellow-500' : 'bg-green-500'
              : 'bg-dispatch-border'
          }`}
          style={{ height: `${25 + i * 10}%` }}
        />
      ))}
    </div>
  );
}

export default function ChannelTile({ channel, onRemove }) {
  const { user } = useAuth();
  const localIdentity = (user?.unit_id && user.unit_id.trim()) || user?.username || "Unknown";
  const { 
    monitoredChannelIds, 
    mutedChannelIds, 
    txChannelIds,
    channelLevels,
    setChannelLevel,
    activeTransmissions,
    unitSignalQuality,
    emergencies,
    pttState,
    priorityChannelId,
    toggleMonitor, 
    toggleMute,
    toggleTx,
    setPriorityChannel,
  } = useDispatchStore();

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: channel.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const isMonitored = monitoredChannelIds.includes(channel.id);
  const isMuted = mutedChannelIds.includes(channel.id);
  const isTxSelected = txChannelIds.includes(channel.id);
  const isPriority = priorityChannelId === channel.id;
  const level = channelLevels[channel.id] || 0;
  const volumeLevel = channelLevels[`volume_${channel.id}`] ?? 100;
  const roomKey = channel.room_key || ((channel.zone || 'Default') + '__' + channel.name);
  const activeTransmission = activeTransmissions[roomKey];
  const hasEmergency = emergencies.some(e => e.channel === roomKey);

  const handleVolumeChange = (e) => {
    setChannelLevel(`volume_${channel.id}`, parseInt(e.target.value, 10));
  };

  const handleRemoveClick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onRemove) {
      onRemove(channel.id);
    }
  };

  const handleMuteToggle = () => {
    toggleMute(channel.id);
    if (mutedChannelIds.includes(channel.id)) {
      audioTransportManager.unmuteChannel(roomKey);
    } else {
      audioTransportManager.muteChannel(roomKey);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`channel-tile ${hasEmergency ? 'emergency' : ''} ${isTxSelected ? 'selected' : ''} ${isDragging ? 'z-50' : ''}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0" {...attributes} {...listeners}>
          <span className="text-xs text-dispatch-secondary cursor-grab">⋮⋮</span>
          <div className="min-w-0">
            {channel.zone && (
              <p className="text-xs text-dispatch-secondary leading-tight">ZN-{channel.zone}</p>
            )}
            <div className="flex items-center gap-1.5">
              <h3 className="font-bold text-dispatch-text leading-tight">CH-{channel.name}</h3>
              <ConnectionStatusIndicator roomKey={roomKey} isMonitored={isMonitored} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <AudioLevelMeter level={level} />
          {onRemove && (
            <button
              type="button"
              onClick={handleRemoveClick}
              onPointerDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
              className="channel-remove-btn"
              title="Remove from grid"
              aria-label={`Remove ${channel.name} from grid`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {hasEmergency && (
        <div className="px-2 py-1 mb-2 text-xs font-bold text-center text-white bg-red-600 rounded animate-pulse">
          EMERGENCY
        </div>
      )}

      {(pttState === PTT_STATES.TRANSMITTING || pttState === PTT_STATES.ARMING) && isTxSelected && (
        <div className="px-2 py-1 mb-2 text-xs font-bold text-center text-white bg-green-600 rounded">
          TX
        </div>
      )}

      {activeTransmission && activeTransmission.from !== localIdentity && activeTransmission.from !== user?.username && !((pttState === PTT_STATES.TRANSMITTING || pttState === PTT_STATES.ARMING) && isTxSelected) && (
        <div className="px-2 py-1 mb-2 text-xs text-center text-yellow-200 bg-yellow-900 rounded">
          <span>RX: {activeTransmission.from}</span>
          {(() => {
            const sq = unitSignalQuality?.[activeTransmission.from];
            if (!sq) return null;
            // Only show bars from a fresh report on the same channel,
            // so stale or cross-channel telemetry never misleads the
            // dispatcher.
            const sameChannel = !sq.channelId || sq.channelId === roomKey;
            const fresh = !sq.timestamp || Date.now() - sq.timestamp < 15_000;
            if (!sameChannel || !fresh) return null;
            return (
              <SignalBars
                quality={sq.quality}
                lossPct={sq.lossPct}
                jitterMs={sq.jitterMs}
              />
            );
          })()}
        </div>
      )}


      <div className="tile-btn-group">
        <button
          onClick={() => toggleMonitor(channel.id)}
          className={`tile-btn tile-btn-fixed ${
            isMonitored 
              ? 'tile-btn-active tile-btn-monitor' 
              : 'tile-btn-default'
          }`}
        >
          <span className="flex items-center justify-center gap-1">
            <svg className={`w-3 h-3 ${isMonitored ? 'opacity-100' : 'opacity-30'}`} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Monitor
          </span>
        </button>
        
        <button
          onClick={handleMuteToggle}
          disabled={!isMonitored}
          className={`tile-btn tile-btn-fixed ${
            isMuted 
              ? 'tile-btn-active tile-btn-mute' 
              : 'tile-btn-default'
          } ${!isMonitored ? 'opacity-40 cursor-not-allowed' : ''}`}
        >
          <span className="flex items-center justify-center gap-1">
            <svg className={`w-3 h-3 ${isMuted ? 'opacity-100' : 'opacity-30'}`} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM12.293 7.293a1 1 0 011.414 0L15 8.586l1.293-1.293a1 1 0 111.414 1.414L16.414 10l1.293 1.293a1 1 0 01-1.414 1.414L15 11.414l-1.293 1.293a1 1 0 01-1.414-1.414L13.586 10l-1.293-1.293a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
            Mute
          </span>
        </button>
        
        <button
          onClick={() => toggleTx(channel.id)}
          className={`tile-btn tile-btn-fixed ${
            isTxSelected 
              ? 'tile-btn-active tile-btn-tx' 
              : 'tile-btn-default'
          }`}
        >
          <span className="flex items-center justify-center gap-1">
            <svg className={`w-3 h-3 ${isTxSelected ? 'opacity-100' : 'opacity-30'}`} fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            TX
          </span>
        </button>

        <button
          onClick={() => setPriorityChannel(channel.id)}
          className={`tile-btn tile-btn-fixed ${
            isPriority
              ? 'tile-btn-active tile-btn-priority'
              : 'tile-btn-default'
          }`}
          title={isPriority ? 'This is the priority channel (audio active)' : 'Set as priority channel'}
        >
          <span className="flex items-center justify-center gap-1">
            <svg className={`w-3 h-3 ${isPriority ? 'opacity-100' : 'opacity-30'}`} fill="currentColor" viewBox="0 0 20 20">
              <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
            </svg>
            Priority
          </span>
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 min-w-0">
        <svg className="w-3 h-3 text-dispatch-secondary flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217z" clipRule="evenodd" />
        </svg>
        <input
          type="range"
          min="0"
          max="100"
          value={volumeLevel}
          onChange={handleVolumeChange}
          className="volume-slider flex-1 min-w-0"
          style={{ width: '100%' }}
          title={`Volume: ${volumeLevel}%`}
        />
        <svg className="w-4 h-4 text-dispatch-secondary flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M9.383 3.076A1 1 0 0110 4v12a1 1 0 01-1.707.707L4.586 13H2a1 1 0 01-1-1V8a1 1 0 011-1h2.586l3.707-3.707a1 1 0 011.09-.217zM14.657 2.929a1 1 0 011.414 0A9.972 9.972 0 0119 10a9.972 9.972 0 01-2.929 7.071 1 1 0 01-1.414-1.414A7.971 7.971 0 0017 10c0-2.21-.894-4.208-2.343-5.657a1 1 0 010-1.414zm-2.829 2.828a1 1 0 011.415 0A5.983 5.983 0 0115 10a5.984 5.984 0 01-1.757 4.243 1 1 0 01-1.415-1.415A3.984 3.984 0 0013 10a3.983 3.983 0 00-1.172-2.828 1 1 0 010-1.415z" clipRule="evenodd" />
        </svg>
      </div>
    </div>
  );
}
