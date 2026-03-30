import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import useDispatchStore from '../../state/dispatchStore.js';
import audioTransportManager from '../../audio/AudioTransportManager.js';
import { PTT_STATES } from '../../constants/pttStates.js';

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
  const { 
    monitoredChannelIds, 
    mutedChannelIds, 
    txChannelIds,
    channelLevels,
    setChannelLevel,
    activeTransmissions,
    emergencies,
    pttState,
    toggleMonitor, 
    toggleMute,
    toggleTx,
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
            <h3 className="font-bold text-dispatch-text leading-tight">CH-{channel.name}</h3>
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

      {activeTransmission && !((pttState === PTT_STATES.TRANSMITTING || pttState === PTT_STATES.ARMING) && isTxSelected) && (
        <div className="px-2 py-1 mb-2 text-xs text-center text-yellow-200 bg-yellow-900 rounded">
          RX: {activeTransmission.from}
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
