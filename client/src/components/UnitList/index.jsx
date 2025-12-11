import { useUnitStore } from '../../state/units.js';

function StatusDot({ status, isEmergency }) {
  const color = isEmergency 
    ? 'bg-red-500' 
    : status === 'transmitting' 
      ? 'bg-yellow-500' 
      : 'bg-green-500';
  
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${color} ${isEmergency ? 'animate-pulse' : ''}`} />
  );
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function UnitList() {
  const { units, filter, setFilter, getFilteredUnits, emergencyUnits } = useUnitStore();
  const filteredUnits = getFilteredUnits();

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wide">Units</h2>
        <span className="text-xs text-gray-400">{filteredUnits.length} total</span>
      </div>

      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setFilter('all')}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            filter === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('online')}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            filter === 'online' ? 'bg-green-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Online
        </button>
        <button
          onClick={() => setFilter('emergency')}
          className={`px-2 py-1 text-xs rounded transition-colors ${
            filter === 'emergency' ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Emergency ({emergencyUnits.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 scrollbar-thin">
        {filteredUnits.length === 0 ? (
          <div className="text-xs text-gray-500 text-center py-4">
            No units found
          </div>
        ) : (
          filteredUnits.map(unit => (
            <div
              key={unit.id}
              className={`p-2 rounded text-sm transition-colors ${
                unit.is_emergency 
                  ? 'bg-red-900/50 border border-red-600' 
                  : 'bg-gray-800 hover:bg-gray-700'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot status={unit.status} isEmergency={unit.is_emergency} />
                  <span className="font-medium text-white">{unit.unit_identity}</span>
                </div>
                <span className="text-xs text-gray-400">{formatTime(unit.last_seen)}</span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-xs text-gray-400">{unit.channel || 'Unknown'}</span>
                <span className="text-xs text-gray-500">{unit.status}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
