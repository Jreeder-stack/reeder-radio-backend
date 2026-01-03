import { useState } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';

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
  const { units, emergencies } = useDispatchStore();
  const [filter, setFilter] = useState('all');
  
  const getFilteredUnits = () => {
    switch (filter) {
      case 'online':
        return units.filter(u => {
          const lastSeen = new Date(u.last_seen);
          const now = new Date();
          return (now - lastSeen) < 60000;
        });
      case 'emergency':
        return units.filter(u => u.is_emergency);
      default:
        return units;
    }
  };
  
  const filteredUnits = getFilteredUnits();
  const emergencyCount = units.filter(u => u.is_emergency).length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-dispatch-text uppercase tracking-wide">Units</h2>
        <span className="text-xs text-dispatch-secondary">{filteredUnits.length} total</span>
      </div>

      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setFilter('all')}
          className={`tile-btn ${filter === 'all' ? 'tile-btn-active tile-btn-tx' : 'tile-btn-default'}`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('online')}
          className={`tile-btn ${filter === 'online' ? 'tile-btn-active tile-btn-monitor' : 'tile-btn-default'}`}
        >
          Online
        </button>
        <button
          onClick={() => setFilter('emergency')}
          className={`tile-btn ${filter === 'emergency' ? 'tile-btn-active tile-btn-mute' : 'tile-btn-default'}`}
        >
          Emergency ({emergencyCount})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-1 scrollbar-thin">
        {filteredUnits.length === 0 ? (
          <div className="text-xs text-dispatch-secondary text-center py-4">
            No units found
          </div>
        ) : (
          filteredUnits.map(unit => (
            <div
              key={unit.id}
              className={`unit-card p-2.5 rounded-md text-sm transition-all ${
                unit.is_emergency 
                  ? 'unit-card-emergency' 
                  : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <StatusDot status={unit.status} isEmergency={unit.is_emergency} />
                  <span className="font-medium text-dispatch-text">{unit.unit_identity}</span>
                </div>
                <span className="text-xs text-dispatch-tertiary font-mono">{formatTime(unit.last_seen)}</span>
              </div>
              <div className="flex items-center justify-between mt-1.5">
                <span className="text-xs text-dispatch-secondary">{unit.channel || 'Unknown'}</span>
                <span className="text-xs px-1.5 py-0.5 rounded bg-dispatch-border text-dispatch-secondary">{unit.status}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
