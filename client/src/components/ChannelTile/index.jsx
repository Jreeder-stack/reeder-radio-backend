import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import useDispatchStore from '../../state/dispatchStore.js';
import livekitManager from '../../audio/LiveKitManager.js';

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
              : 'bg-gray-700'
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
    activeTransmissions,
    unitsByChannel,
    emergencies,
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
  const activeTransmission = activeTransmissions[channel.id];
  const unitsInChannel = unitsByChannel[channel.name] || [];
  const hasEmergency = emergencies.some(e => e.channel === channel.name);

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
      livekitManager.unmuteChannel(channel.name);
    } else {
      livekitManager.muteChannel(channel.name);
    }
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`channel-tile ${hasEmergency ? 'emergency' : ''} ${isTxSelected ? 'selected' : ''} ${isDragging ? 'z-50' : ''}`}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2" {...attributes} {...listeners}>
          <span className="text-xs text-gray-500 cursor-grab">⋮⋮</span>
          <h3 className="font-bold text-white">{channel.name}</h3>
        </div>
        <div className="flex items-center gap-2">
          <AudioLevelMeter level={level} />
          {onRemove && (
            <button
              type="button"
              onMouseDown={handleRemoveClick}
              onPointerDown={(e) => e.stopPropagation()}
              className="w-5 h-5 flex items-center justify-center text-gray-500 hover:text-red-500 hover:bg-red-900/30 rounded text-xs"
              title="Remove from grid"
            >
              ×
            </button>
          )}
        </div>
      </div>

      {hasEmergency && (
        <div className="px-2 py-1 mb-2 text-xs font-bold text-center text-white bg-red-600 rounded animate-pulse">
          EMERGENCY
        </div>
      )}

      {activeTransmission && (
        <div className="px-2 py-1 mb-2 text-xs text-center text-yellow-200 bg-yellow-900 rounded">
          TX: {activeTransmission.from}
        </div>
      )}

      <div className="flex items-center gap-1 mb-2">
        <span className="text-xs text-gray-400">Units:</span>
        <span className="text-xs text-white">{unitsInChannel.length}</span>
      </div>

      <div className="flex flex-wrap gap-1.5 mt-2">
        <button
          onClick={() => toggleMonitor(channel.id)}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            isMonitored 
              ? 'bg-green-600 text-white' 
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          {isMonitored ? 'Monitoring' : 'Monitor'}
        </button>
        
        <button
          onClick={handleMuteToggle}
          disabled={!isMonitored}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            isMuted 
              ? 'bg-red-600 text-white' 
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          } ${!isMonitored ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {isMuted ? 'Muted' : 'Mute'}
        </button>
        
        <button
          onClick={() => toggleTx(channel.id)}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            isTxSelected 
              ? 'bg-blue-600 text-white ring-2 ring-blue-400' 
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          TX {isTxSelected ? '✓' : ''}
        </button>
      </div>

      <div className="mt-2">
        <input
          type="range"
          min="0"
          max="100"
          defaultValue="100"
          className="w-full h-1 bg-gray-700 rounded appearance-none cursor-pointer"
          title="Volume"
        />
      </div>
    </div>
  );
}
