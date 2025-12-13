import useDispatchStore from '../../state/dispatchStore.js';

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getEventColor(type) {
  switch (type) {
    case 'emergency':
    case 'emergency_activated':
      return 'text-red-400';
    case 'emergency_ack':
      return 'text-green-400';
    case 'ptt_start':
    case 'transmitting':
      return 'text-yellow-400';
    case 'ptt_end':
      return 'text-dispatch-tertiary';
    case 'connect':
      return 'text-blue-400';
    case 'disconnect':
      return 'text-orange-400';
    case 'patch_enabled':
      return 'text-purple-400';
    case 'tone':
      return 'text-amber-400';
    default:
      return 'text-dispatch-secondary';
  }
}

function getEventIcon(type) {
  switch (type) {
    case 'emergency':
    case 'emergency_activated':
      return '🚨';
    case 'emergency_ack':
      return '✓';
    case 'ptt_start':
    case 'transmitting':
      return '🎙️';
    case 'ptt_end':
      return '⏹️';
    case 'connect':
      return '🔗';
    case 'disconnect':
      return '⛓️‍💥';
    case 'patch_enabled':
      return '🔀';
    case 'tone':
      return '🔔';
    default:
      return '📋';
  }
}

export default function EventLog() {
  const { events, setEvents } = useDispatchStore();
  
  const clearEvents = () => setEvents([]);

  return (
    <div className="flex flex-col h-full p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-dispatch-text uppercase tracking-wide">Event Log</h2>
        <button
          onClick={clearEvents}
          className="text-xs text-dispatch-secondary hover:text-dispatch-text transition-colors"
        >
          Clear
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 scrollbar-thin">
        {events.length === 0 ? (
          <div className="text-xs text-dispatch-secondary text-center py-4">
            No events yet
          </div>
        ) : (
          events.map(event => (
            <div
              key={event.id}
              className="p-2 bg-dispatch-panel rounded text-xs"
            >
              <div className="flex items-center gap-2">
                <span>{getEventIcon(event.type)}</span>
                <span className={`font-medium ${getEventColor(event.type)}`}>
                  {event.type.replace(/_/g, ' ').toUpperCase()}
                </span>
                <span className="text-dispatch-secondary ml-auto">{formatTime(event.timestamp)}</span>
              </div>
              {event.unit && (
                <div className="text-dispatch-secondary mt-1">
                  Unit: {event.unit} {event.channel && `| Channel: ${event.channel}`}
                </div>
              )}
              {event.acknowledgedBy && (
                <div className="text-green-400 mt-1">
                  Ack by: {event.acknowledgedBy}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
