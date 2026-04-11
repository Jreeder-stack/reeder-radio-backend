import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'commandcomms_audio_settings';

const DEFAULTS = {
  incomingVolume: 100,
  micVolume: 100,
  playbackAmplifier: false,
  recordingAmplifier: false,
  noiseSuppression: false,
};

function clamp(v, min, max) {
  const n = Number(v);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function sanitize(raw) {
  return {
    incomingVolume: clamp(raw.incomingVolume ?? DEFAULTS.incomingVolume, 0, 150),
    micVolume: clamp(raw.micVolume ?? DEFAULTS.micVolume, 0, 150),
    playbackAmplifier: !!raw.playbackAmplifier,
    recordingAmplifier: !!raw.recordingAmplifier,
    noiseSuppression: !!raw.noiseSuppression,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return sanitize(JSON.parse(raw));
  } catch (_) {}
  return { ...DEFAULTS };
}

function save(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {}
}

export function getAudioSettings() {
  return load();
}

export default function AudioSettings({ open, onClose, onChange }) {
  const [settings, setSettings] = useState(load);

  useEffect(() => {
    if (open) setSettings(load());
  }, [open]);

  const update = useCallback((key, value) => {
    setSettings(prev => {
      const next = { ...prev, [key]: value };
      save(next);
      onChange?.(next);
      return next;
    });
  }, [onChange]);

  const reset = useCallback(() => {
    save(DEFAULTS);
    setSettings({ ...DEFAULTS });
    onChange?.({ ...DEFAULTS });
  }, [onChange]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div className="relative bg-dispatch-panel border border-dispatch-border rounded-xl shadow-2xl w-full max-w-md mx-4 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dispatch-border">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M12 6a7.975 7.975 0 015.657 2.343M12 6a7.975 7.975 0 00-5.657 2.343M6.343 15.536a5 5 0 010-7.072M9 12a3 3 0 106 0 3 3 0 00-6 0z" />
            </svg>
            <h2 className="text-lg font-bold text-dispatch-text">Audio Settings</h2>
          </div>
          <button onClick={onClose} className="text-dispatch-secondary hover:text-dispatch-text transition-colors p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-5 space-y-5 max-h-[70vh] overflow-y-auto">
          <section className="space-y-4">
            <h3 className="text-xs font-bold text-dispatch-secondary uppercase tracking-widest">Receive Audio</h3>

            <SliderSetting
              label="Incoming Volume"
              description="Master volume for received transmissions"
              value={settings.incomingVolume}
              min={0}
              max={150}
              unit="%"
              onChange={v => update('incomingVolume', v)}
            />

            <ToggleSetting
              label="Playback Amplifier"
              description="2x boost for quiet incoming audio"
              checked={settings.playbackAmplifier}
              onChange={v => update('playbackAmplifier', v)}
            />
          </section>

          <div className="border-t border-dispatch-border" />

          <section className="space-y-4">
            <h3 className="text-xs font-bold text-dispatch-secondary uppercase tracking-widest">Transmit Audio</h3>

            <SliderSetting
              label="Mic Volume"
              description="Microphone gain for outgoing transmissions"
              value={settings.micVolume}
              min={0}
              max={150}
              unit="%"
              onChange={v => update('micVolume', v)}
            />

            <ToggleSetting
              label="Recording Amplifier"
              description="2x boost on outgoing mic audio"
              checked={settings.recordingAmplifier}
              onChange={v => update('recordingAmplifier', v)}
            />

            <ToggleSetting
              label="Noise Suppression"
              description="Reduce background noise on outgoing audio"
              checked={settings.noiseSuppression}
              onChange={v => update('noiseSuppression', v)}
            />
          </section>
        </div>

        <div className="px-5 py-3 border-t border-dispatch-border flex justify-between items-center">
          <button
            onClick={reset}
            className="text-xs text-dispatch-secondary hover:text-red-400 transition-colors font-medium"
          >
            Reset to Defaults
          </button>
          <span className="text-[10px] text-dispatch-secondary/50">Changes apply instantly</span>
        </div>
      </div>
    </div>
  );
}

function SliderSetting({ label, description, value, min, max, unit, onChange }) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-dispatch-text">{label}</p>
          <p className="text-[10px] text-dispatch-secondary">{description}</p>
        </div>
        <span className="text-sm font-bold text-primary tabular-nums min-w-[3rem] text-right">
          {value}{unit}
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(parseInt(e.target.value))}
          className="w-full h-2 rounded-full appearance-none cursor-pointer audio-slider"
          style={{
            background: `linear-gradient(to right, var(--color-primary) 0%, var(--color-primary) ${pct}%, rgba(255,255,255,0.1) ${pct}%, rgba(255,255,255,0.1) 100%)`
          }}
        />
      </div>
    </div>
  );
}

function ToggleSetting({ label, description, checked, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium text-dispatch-text">{label}</p>
        <p className="text-[10px] text-dispatch-secondary">{description}</p>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${checked ? 'bg-primary' : 'bg-white/10'}`}
      >
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}
