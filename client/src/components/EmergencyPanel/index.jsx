import { useEffect, useRef, useState } from 'react';
import useDispatchStore from '../../state/dispatchStore.js';
import { toggleUnitEmergency, resetEmergency as resetEmergencyApi } from '../../utils/api.js';
import { useAuth } from '../../AuthContext.jsx';
import { useSignalingContext } from '../../context/SignalingContext.jsx';
import { formatRoomKey } from '../../utils/formatChannelDisplay.js';

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
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

function ResetConfirmDialog({ emergency, onConfirm, onCancel }) {
  const [inputValue, setInputValue] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (inputValue.trim().toUpperCase() === (emergency.unitIdentity || '').toUpperCase()) {
      onConfirm(inputValue.trim());
    } else {
      setError('Unit ID does not match. Please try again.');
    }
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0,0,0,0.7)',
      zIndex: 99999,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        background: '#1e293b',
        border: '2px solid #dc2626',
        borderRadius: '8px',
        padding: '24px',
        maxWidth: '400px',
        width: '90%',
      }}>
        <h3 style={{ color: '#fff', margin: '0 0 12px', fontSize: '16px' }}>
          Reset Emergency — {emergency.unitIdentity}
        </h3>
        <p style={{ color: '#94a3b8', fontSize: '13px', margin: '0 0 16px' }}>
          To confirm the reset, type the unit's ID: <strong style={{ color: '#fff' }}>{emergency.unitIdentity}</strong>
        </p>
        <form onSubmit={handleSubmit}>
          <input
            type="text"
            value={inputValue}
            onChange={(e) => { setInputValue(e.target.value); setError(''); }}
            placeholder="Enter unit ID"
            autoFocus
            style={{
              width: '100%',
              padding: '8px 12px',
              fontSize: '14px',
              background: '#0f172a',
              border: '1px solid #334155',
              borderRadius: '4px',
              color: '#fff',
              marginBottom: '8px',
              boxSizing: 'border-box',
            }}
          />
          {error && (
            <p style={{ color: '#f87171', fontSize: '12px', margin: '0 0 8px' }}>{error}</p>
          )}
          <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
            <button
              type="button"
              onClick={onCancel}
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '13px',
                fontWeight: 'bold',
                background: '#334155',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              CANCEL
            </button>
            <button
              type="submit"
              style={{
                flex: 1,
                padding: '8px',
                fontSize: '13px',
                fontWeight: 'bold',
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
              }}
            >
              CONFIRM RESET
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function EmergencyPanel() {
  const { emergencies, acknowledgeEmergency: storeAcknowledge, removeEmergency, updateUnit, addEvent, dispatcherName } = useDispatchStore();
  const { signalEmergencyEnd } = useSignalingContext();
  const [resetTarget, setResetTarget] = useState(null);

  const handleAcknowledge = (emergency) => {
    storeAcknowledge(emergency.id);
    addEvent({
      type: 'emergency_ack',
      unit: emergency.unitIdentity,
      channel: emergency.channel,
      acknowledgedBy: dispatcherName || 'DISPATCH',
    });
  };

  const handleResetClick = (emergency) => {
    setResetTarget(emergency);
  };

  const handleResetConfirm = async (typedConfirmation) => {
    if (!resetTarget) return;
    try {
      await resetEmergencyApi(resetTarget.unitIdentity, resetTarget.channel, typedConfirmation);
      if (resetTarget.unitId) {
        await toggleUnitEmergency(resetTarget.unitId, false);
        updateUnit(resetTarget.unitIdentity, { is_emergency: false, status: 'idle' });
      }
      if (resetTarget.channel) {
        signalEmergencyEnd(resetTarget.channel);
      }
      removeEmergency(resetTarget.id);
      addEvent({
        type: 'emergency_reset',
        unit: resetTarget.unitIdentity,
        channel: resetTarget.channel,
        resetBy: dispatcherName || 'DISPATCH',
      });
    } catch (error) {
      console.error('Failed to reset emergency:', error);
    }
    setResetTarget(null);
  };

  const handleResetCancel = () => {
    setResetTarget(null);
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
              className={`p-3 border rounded ${
                emergency.acknowledged
                  ? 'bg-red-900/30 border-red-700'
                  : 'bg-red-900/50 border-red-600 animate-pulse'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-white">{emergency.unitIdentity}</span>
                <div className="flex items-center gap-2">
                  {emergency.acknowledged && (
                    <span className="text-[10px] text-yellow-400 uppercase font-semibold">Acknowledged</span>
                  )}
                  <span className="text-xs text-red-300">{formatTime(emergency.timestamp)}</span>
                </div>
              </div>
              <div className="text-xs text-red-200 mb-2">
                Channel: {formatRoomKey(emergency.channel)}
              </div>
              {emergency.acknowledged ? (
                <button
                  onClick={() => handleResetClick(emergency)}
                  className="w-full px-3 py-1.5 text-sm font-bold bg-red-700 hover:bg-red-800 text-white rounded transition-colors"
                >
                  RESET
                </button>
              ) : (
                <button
                  onClick={() => handleAcknowledge(emergency)}
                  className="w-full px-3 py-1.5 text-sm font-bold bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
                >
                  ACKNOWLEDGE
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {resetTarget && (
        <ResetConfirmDialog
          emergency={resetTarget}
          onConfirm={handleResetConfirm}
          onCancel={handleResetCancel}
        />
      )}
    </div>
  );
}

export function GlobalEmergencyOverlay() {
  const { user } = useAuth();
  const { emergencies, acknowledgeEmergency: storeAcknowledge, addEvent, dispatcherName } = useDispatchStore();
  const alarmStopRef = useRef(null);

  const isDispatchOrAdmin = user && (user.is_dispatcher || user.role === 'admin');

  const unacknowledgedEmergencies = emergencies.filter(e => !e.acknowledged);

  useEffect(() => {
    if (!isDispatchOrAdmin) {
      if (alarmStopRef.current) {
        alarmStopRef.current();
        alarmStopRef.current = null;
      }
      return;
    }
    if (unacknowledgedEmergencies.length > 0 && !alarmStopRef.current) {
      alarmStopRef.current = startAlarmTone();
    } else if (unacknowledgedEmergencies.length === 0 && alarmStopRef.current) {
      alarmStopRef.current();
      alarmStopRef.current = null;
    }
  }, [unacknowledgedEmergencies.length, isDispatchOrAdmin]);

  useEffect(() => {
    return () => {
      if (alarmStopRef.current) {
        alarmStopRef.current();
        alarmStopRef.current = null;
      }
    };
  }, []);

  if (!isDispatchOrAdmin || unacknowledgedEmergencies.length === 0) return null;

  const handleAcknowledge = (emergency) => {
    storeAcknowledge(emergency.id);
    addEvent({
      type: 'emergency_ack',
      unit: emergency.unitIdentity,
      channel: emergency.channel,
      acknowledgedBy: dispatcherName || 'DISPATCH',
    });
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
        {unacknowledgedEmergencies.map(emergency => (
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
              Channel: {formatRoomKey(emergency.channel)}
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
