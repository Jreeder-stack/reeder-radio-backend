import { useEffect, useRef } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';
import { toggleUnitEmergency } from '../../utils/api.js';
import { useAuth } from '../../AuthContext.jsx';

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function startAlarmTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const gainNode = ctx.createGain();
    gainNode.gain.value = 0.4;
    gainNode.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'square';
    osc1.frequency.value = 1200;
    osc1.connect(gainNode);

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 1800;
    osc2.connect(gainNode);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 2;
    const lfoGain1 = ctx.createGain();
    lfoGain1.gain.value = 1;
    const lfoGain2 = ctx.createGain();
    lfoGain2.gain.value = 1;

    lfo.connect(lfoGain1.gain);
    lfo.connect(lfoGain2.gain);

    const gain1 = ctx.createGain();
    gain1.gain.value = 0;
    osc1.connect(gain1);
    gain1.connect(gainNode);

    const gain2 = ctx.createGain();
    gain2.gain.value = 0;
    osc2.connect(gain2);
    gain2.connect(gainNode);

    osc1.start();
    osc2.start();
    lfo.start();

    let toggle = true;
    const interval = setInterval(() => {
      gain1.gain.value = toggle ? 0.5 : 0;
      gain2.gain.value = toggle ? 0 : 0.5;
      toggle = !toggle;
    }, 500);

    return () => {
      clearInterval(interval);
      try {
        osc1.stop();
        osc2.stop();
        lfo.stop();
        ctx.close();
      } catch (e) {}
    };
  } catch (e) {
    console.error('[EmergencyAlarm] Failed to start:', e);
    return () => {};
  }
}

export default function EmergencyPanel() {
  const { emergencies, removeEmergency, updateUnit, addEvent, dispatcherName } = useDispatchStore();

  const handleAcknowledge = async (emergency) => {
    try {
      if (emergency.unitId) {
        await toggleUnitEmergency(emergency.unitId, false);
        updateUnit(emergency.unitIdentity, { is_emergency: false, status: 'idle' });
      }
      removeEmergency(emergency.id);
      addEvent({
        type: 'emergency_ack',
        unit: emergency.unitIdentity,
        channel: emergency.channel,
        acknowledgedBy: dispatcherName || 'DISPATCH',
      });
    } catch (error) {
      console.error('Failed to acknowledge emergency:', error);
    }
  };

  return (
    <div className="flex flex-col h-full p-3">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-dispatch-text uppercase tracking-wide">
          Emergencies
        </h2>
        {emergencies.length > 0 && (
          <span className="px-2 py-0.5 text-xs font-bold text-white bg-red-600 rounded-full animate-pulse">
            {emergencies.length}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto space-y-2 scrollbar-thin">
        {emergencies.length === 0 ? (
          <div className="text-xs text-dispatch-secondary text-center py-4">
            No active emergencies
          </div>
        ) : (
          emergencies.map(emergency => (
            <div
              key={emergency.id}
              className="p-3 bg-red-900/50 border border-red-600 rounded animate-pulse"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-white">{emergency.unitIdentity}</span>
                <span className="text-xs text-red-300">{formatTime(emergency.timestamp)}</span>
              </div>
              <div className="text-xs text-red-200 mb-2">
                Channel: {emergency.channel || 'Unknown'}
              </div>
              <button
                onClick={() => handleAcknowledge(emergency)}
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

export function GlobalEmergencyOverlay() {
  const { user } = useAuth();
  const { emergencies, removeEmergency, updateUnit, addEvent, dispatcherName } = useDispatchStore();
  const alarmStopRef = useRef(null);

  const isDispatchOrAdmin = user && (user.is_dispatcher || user.role === 'admin');

  useEffect(() => {
    if (!isDispatchOrAdmin) {
      if (alarmStopRef.current) {
        alarmStopRef.current();
        alarmStopRef.current = null;
      }
      return;
    }
    if (emergencies.length > 0 && !alarmStopRef.current) {
      alarmStopRef.current = startAlarmTone();
    } else if (emergencies.length === 0 && alarmStopRef.current) {
      alarmStopRef.current();
      alarmStopRef.current = null;
    }
  }, [emergencies.length, isDispatchOrAdmin]);

  useEffect(() => {
    return () => {
      if (alarmStopRef.current) {
        alarmStopRef.current();
        alarmStopRef.current = null;
      }
    };
  }, []);

  if (!isDispatchOrAdmin || emergencies.length === 0) return null;

  const handleAcknowledge = async (emergency) => {
    try {
      if (emergency.unitId) {
        await toggleUnitEmergency(emergency.unitId, false);
        updateUnit(emergency.unitIdentity, { is_emergency: false, status: 'idle' });
      }
      removeEmergency(emergency.id);
      addEvent({
        type: 'emergency_ack',
        unit: emergency.unitIdentity,
        channel: emergency.channel,
        acknowledgedBy: dispatcherName || 'DISPATCH',
      });
    } catch (error) {
      console.error('Failed to acknowledge emergency:', error);
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 99998,
      pointerEvents: 'none',
    }}>
      <div style={{
        margin: '16px auto',
        maxWidth: '480px',
        pointerEvents: 'auto',
      }}>
        {emergencies.map(emergency => (
          <div
            key={emergency.id}
            style={{
              background: 'rgba(127, 29, 29, 0.95)',
              border: '2px solid #dc2626',
              borderRadius: '8px',
              padding: '12px 16px',
              marginBottom: '8px',
              animation: 'pulse 1s ease-in-out infinite',
              boxShadow: '0 4px 20px rgba(220, 38, 38, 0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '16px' }}>
                ⚠ EMERGENCY — {emergency.unitIdentity}
              </span>
              <span style={{ fontSize: '11px', color: '#fca5a5' }}>
                {formatTime(emergency.timestamp)}
              </span>
            </div>
            <div style={{ fontSize: '12px', color: '#fecaca', marginBottom: '8px' }}>
              Channel: {emergency.channel || 'Unknown'}
            </div>
            <button
              onClick={() => handleAcknowledge(emergency)}
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '14px',
                fontWeight: 'bold',
                background: '#16a34a',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              ACKNOWLEDGE
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
