import { useUnitStore } from '../../state/units.js';
import { toggleUnitEmergency } from '../../utils/api.js';
import { useDispatcherStore } from '../../state/dispatcher.js';

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function EmergencyPanel() {
  const { emergencyUnits, updateUnit } = useUnitStore();
  const { addEvent, dispatcherName } = useDispatcherStore();

  const handleAcknowledge = async (unit) => {
    try {
      await toggleUnitEmergency(unit.id, false);
      updateUnit(unit.id, { is_emergency: false, status: 'idle' });
      addEvent({
        type: 'emergency_ack',
        unit: unit.unit_identity,
        channel: unit.channel,
        acknowledgedBy: dispatcherName,
      });
    } catch (error) {
      console.error('Failed to acknowledge emergency:', error);
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-white uppercase tracking-wide">
          Emergencies
        </h2>
        {emergencyUnits.length > 0 && (
          <span className="px-2 py-0.5 text-xs font-bold text-white bg-red-600 rounded-full animate-pulse">
            {emergencyUnits.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 scrollbar-thin">
        {emergencyUnits.length === 0 ? (
          <div className="text-xs text-gray-500 text-center py-4">
            No active emergencies
          </div>
        ) : (
          emergencyUnits.map(unit => (
            <div
              key={unit.id}
              className="p-3 bg-red-900/50 border border-red-600 rounded animate-pulse"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-white">{unit.unit_identity}</span>
                <span className="text-xs text-red-300">{formatTime(unit.last_seen)}</span>
              </div>
              <div className="text-xs text-red-200 mb-2">
                Channel: {unit.channel || 'Unknown'}
              </div>
              <button
                onClick={() => handleAcknowledge(unit)}
                className="w-full px-3 py-1.5 text-sm font-bold bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
              >
                ACKNOWLEDGE
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
