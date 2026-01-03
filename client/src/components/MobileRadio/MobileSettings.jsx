import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { MobileFrame } from "./MobileFrame";
import { Switch } from "../ui/Switch";
import { Mic, Volume2, Bluetooth, MapPin, Database, ChevronRight, Info, Bell, Radio, AlertTriangle, Shield } from "lucide-react";
import { cn } from "../../lib/utils";
import { 
  getSettings, 
  saveSettings, 
  requestLocationPermissions,
  requestNotificationPermissions,
  requestDndOverridePermission,
  checkDndOverridePermission,
  setHardwarePttKeyCode,
  setupAppLifecycle,
  isNative,
  platform,
} from "../../lib/capacitor";

let pendingDndRequest = false;
let dndStateSetters = null;

async function syncDndPermissionState() {
  if (!isNative) {
    dndStateSetters?.setDndPermissionGranted(true);
    return;
  }
  
  const granted = await checkDndOverridePermission();
  dndStateSetters?.setDndPermissionGranted(granted);
  
  const currentSettings = await getSettings();
  
  if (granted && pendingDndRequest) {
    pendingDndRequest = false;
    if (!currentSettings.dndOverrideEnabled) {
      const newSettings = { ...currentSettings, dndOverrideEnabled: true };
      dndStateSetters?.setSettings(newSettings);
      await saveSettings(newSettings);
    }
  } else if (!granted && currentSettings.dndOverrideEnabled) {
    const newSettings = { ...currentSettings, dndOverrideEnabled: false };
    dndStateSetters?.setSettings(newSettings);
    await saveSettings(newSettings);
  }
}

export function MobileSettings({ onLogout }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState(null);
  const [capturingPtt, setCapturingPtt] = useState(false);
  const [showFreqPicker, setShowFreqPicker] = useState(false);
  const [dndPermissionGranted, setDndPermissionGranted] = useState(false);
  const [interfaceMode, setInterfaceMode] = useState(() => {
    return localStorage.getItem('interface_mode') || 'phone';
  });

  const handleInterfaceModeChange = (mode) => {
    setInterfaceMode(mode);
    localStorage.setItem('interface_mode', mode);
    window.location.reload();
  };

  useEffect(() => {
    dndStateSetters = { setDndPermissionGranted, setSettings };
    
    loadSettings();
    
    if (isNative) {
      setupAppLifecycle(syncDndPermissionState, () => {});
    }
    
    window.addEventListener('focus', syncDndPermissionState);
    return () => {
      window.removeEventListener('focus', syncDndPermissionState);
      dndStateSetters = null;
    };
  }, []);

  useEffect(() => {
    if (!capturingPtt) return;

    const handleKeyDown = async (e) => {
      e.preventDefault();
      if (settings) {
        const newSettings = {
          ...settings,
          pttKeyCode: e.keyCode,
          pttKeyLabel: e.key || `Key ${e.keyCode}`,
        };
        setSettings(newSettings);
        await saveSettings(newSettings);
        await setHardwarePttKeyCode(e.keyCode);
      }
      setCapturingPtt(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [capturingPtt, settings]);

  async function loadSettings() {
    const s = await getSettings();
    setSettings(s);
    await syncDndPermissionState();
  }

  async function updateSetting(key, value) {
    if (!settings) return;
    const newSettings = { ...settings, [key]: value };
    setSettings(newSettings);
    await saveSettings(newSettings);
  }

  async function handleEnableGps() {
    const granted = await requestLocationPermissions();
    if (granted) {
      updateSetting('backgroundGpsEnabled', true);
    }
  }

  async function handleEnableNotifications() {
    const granted = await requestNotificationPermissions();
    if (granted) {
      updateSetting('alertSoundsEnabled', true);
    }
  }

  async function handleEnableDndOverride() {
    if (!isNative) {
      updateSetting('dndOverrideEnabled', true);
      return;
    }
    
    if (dndPermissionGranted) {
      updateSetting('dndOverrideEnabled', true);
    } else {
      pendingDndRequest = true;
      await requestDndOverridePermission();
    }
  }

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    } catch (e) {
      console.error('Logout error:', e);
    }
    onLogout?.();
  };

  function clearPttMapping() {
    if (!settings) return;
    const newSettings = {
      ...settings,
      pttKeyCode: null,
      pttKeyLabel: 'Screen Button',
    };
    setSettings(newSettings);
    saveSettings(newSettings);
  }

  function getFrequencyLabel(freq) {
    if (freq <= 10) return "Very High (10s)";
    if (freq <= 30) return "High (30s)";
    if (freq <= 60) return "Normal (1m)";
    return "Low (5m)";
  }

  if (!settings) {
    return (
      <MobileFrame title="SYSTEM SETTINGS">
        <div className="flex items-center justify-center h-64">
          <p className="text-zinc-500">Loading settings...</p>
        </div>
      </MobileFrame>
    );
  }

  return (
    <MobileFrame title="SYSTEM SETTINGS">
      <div className="p-4 space-y-6">

        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">Platform</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 p-4">
            <p className="text-sm text-zinc-300">
              {isNative ? `Native Android (${platform})` : 'Web Browser'}
            </p>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">Interface Style</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 p-4">
            <p className="text-[10px] text-zinc-500 mb-3">Choose your preferred radio interface</p>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              <button
                type="button"
                onClick={() => handleInterfaceModeChange('phone')}
                className={cn(
                  "flex-1 py-3 px-4 text-xs font-mono uppercase tracking-wider transition-all",
                  interfaceMode === 'phone' 
                    ? "bg-primary text-black font-bold" 
                    : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                )}
              >
                Phone
              </button>
              <button
                type="button"
                onClick={() => handleInterfaceModeChange('radio')}
                className={cn(
                  "flex-1 py-3 px-4 text-xs font-mono uppercase tracking-wider transition-all",
                  interfaceMode === 'radio' 
                    ? "bg-white text-black font-bold" 
                    : "bg-zinc-800 text-zinc-500 hover:text-zinc-300"
                )}
              >
                Radio
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">Hardware Mapping</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 overflow-hidden">
            
            <SettingItem 
              icon={<Volume2 size={18} />}
              title="Volume Button PTT"
              description="Use Volume Up as Push-to-Talk"
              action={
                <Switch 
                  checked={settings.pttKeyLabel.includes('Volume')}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      updateSetting('pttKeyLabel', 'VolumeUp');
                      updateSetting('pttKeyCode', 24);
                    } else {
                      clearPttMapping();
                    }
                  }}
                />
              }
            />
            
            <div 
              className="flex items-center justify-between p-4 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors cursor-pointer active:bg-white/10"
              onClick={() => setCapturingPtt(true)}
            >
              <div className="flex items-center gap-3">
                <div className="text-zinc-400"><Radio size={18} /></div>
                <div>
                  <p className="text-sm font-medium text-zinc-200">Custom PTT Key</p>
                  <p className="text-[10px] text-zinc-500">
                    {capturingPtt ? 'Press any key now...' : `Current: ${settings.pttKeyLabel}`}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("text-xs font-bold", capturingPtt ? 'text-yellow-400 animate-pulse' : 'text-primary')}>
                  {capturingPtt ? 'LISTENING' : 'SET'}
                </span>
                <ChevronRight size={16} className="text-zinc-600" />
              </div>
            </div>

            <SettingItem 
              icon={<Bluetooth size={18} />}
              title="Bluetooth Headset"
              description="Media Button Integration"
              action={<Switch defaultChecked />}
            />

          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">Location Services</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 overflow-hidden">
            
            <SettingItem 
              icon={<MapPin size={18} />}
              title="Background GPS"
              description="Upload GPS coordinates while active"
              action={
                <Switch 
                  checked={settings.backgroundGpsEnabled}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      handleEnableGps();
                    } else {
                      updateSetting('backgroundGpsEnabled', false);
                    }
                  }}
                />
              }
            />
            
            <div 
              className="flex items-center justify-between p-4 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors cursor-pointer active:bg-white/10"
              onClick={() => setShowFreqPicker(!showFreqPicker)}
            >
              <div className="flex items-center gap-3">
                <div className="text-zinc-400"><Database size={18} /></div>
                <div>
                  <p className="text-sm font-medium text-zinc-200">Update Frequency</p>
                  <p className="text-[10px] text-zinc-500">{getFrequencyLabel(settings.gpsUpdateFrequency)}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-zinc-400">{settings.gpsUpdateFrequency}s</span>
                <ChevronRight size={16} className="text-zinc-600" />
              </div>
            </div>

            {showFreqPicker && (
              <div className="p-4 bg-zinc-800/50 border-t border-white/5 space-y-2">
                {[10, 30, 60, 300].map((freq) => (
                  <button
                    key={freq}
                    onClick={() => {
                      updateSetting('gpsUpdateFrequency', freq);
                      setShowFreqPicker(false);
                    }}
                    className={cn(
                      "w-full text-left p-2 rounded text-sm",
                      settings.gpsUpdateFrequency === freq 
                        ? 'bg-primary text-black font-bold' 
                        : 'text-zinc-300 hover:bg-zinc-700'
                    )}
                  >
                    {freq < 60 ? `${freq} seconds` : `${freq / 60} minute${freq > 60 ? 's' : ''}`}
                  </button>
                ))}
              </div>
            )}

          </div>
        </section>

        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">Audio</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 overflow-hidden">
            
            <SettingItem 
              icon={<Mic size={18} />}
              title="Background Audio"
              description="Keep receiving radio when app is minimized"
              action={
                <Switch 
                  checked={settings.backgroundAudioEnabled}
                  onCheckedChange={(checked) => updateSetting('backgroundAudioEnabled', checked)}
                />
              }
            />
            
            <SettingItem 
              icon={<Bell size={18} />}
              title="Alert Sounds"
              description="Play sounds for alerts and notifications"
              action={
                <Switch 
                  checked={settings.alertSoundsEnabled}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      handleEnableNotifications();
                    } else {
                      updateSetting('alertSoundsEnabled', false);
                    }
                  }}
                />
              }
            />

          </div>
        </section>

        {isNative && (
        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">Do Not Disturb Override</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 overflow-hidden">
            
            <div className="p-4 border-b border-white/5 bg-amber-900/20">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-[10px] text-amber-200/80 leading-relaxed">
                  Mission-critical alerts can bypass Do Not Disturb mode to ensure you never miss emergency traffic. This requires system permission.
                </p>
              </div>
            </div>
            
            <SettingItem 
              icon={<Shield size={18} />}
              title="Override Do Not Disturb"
              description={
                dndPermissionGranted && settings.dndOverrideEnabled 
                  ? "Enabled - permission granted" 
                  : dndPermissionGranted 
                    ? "Tap to enable" 
                    : "Tap to request permission"
              }
              action={
                <Switch 
                  checked={dndPermissionGranted && settings.dndOverrideEnabled}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      handleEnableDndOverride();
                    } else {
                      updateSetting('dndOverrideEnabled', false);
                    }
                  }}
                />
              }
            />

            {settings.dndOverrideEnabled && (
              <>
                <SettingItem 
                  icon={<AlertTriangle size={18} />}
                  title="Emergency Button"
                  description="Emergency activations bypass DND"
                  action={
                    <Switch 
                      checked={settings.dndOverrideEmergency}
                      onCheckedChange={(checked) => updateSetting('dndOverrideEmergency', checked)}
                    />
                  }
                />
                
                <SettingItem 
                  icon={<Bell size={18} />}
                  title="CAD Priority Events"
                  description="High-priority CAD alerts bypass DND"
                  action={
                    <Switch 
                      checked={settings.dndOverrideCadPriority}
                      onCheckedChange={(checked) => updateSetting('dndOverrideCadPriority', checked)}
                    />
                  }
                />
                
                <SettingItem 
                  icon={<Radio size={18} />}
                  title="Officer Down Alerts"
                  description="Officer down signals bypass DND"
                  action={
                    <Switch 
                      checked={settings.dndOverrideOfficerDown}
                      onCheckedChange={(checked) => updateSetting('dndOverrideOfficerDown', checked)}
                    />
                  }
                />
              </>
            )}

          </div>
        </section>
        )}

        <section className="space-y-3">
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest px-2">About</h3>
          <div className="bg-zinc-900/50 rounded-xl border border-white/5 overflow-hidden p-4 flex items-start gap-4">
            <div className="bg-zinc-800 p-2 rounded-lg text-primary">
              <Info size={24} />
            </div>
            <div>
              <h4 className="font-bold text-white text-sm">Command Communications</h4>
              <p className="text-xs text-zinc-500 mt-1">Version 1.0.0 (Build 1001)</p>
              <p className="text-[10px] text-zinc-600 mt-2 font-mono">
                © 2025 REEDER-SYSTEMS<br/>
                {isNative ? 'Native Android Edition' : 'Web Edition'}
              </p>
            </div>
          </div>
        </section>

        <button 
          className="w-full py-3 border border-red-900/50 text-red-500 hover:bg-red-950/30 hover:text-red-400 rounded-lg font-bold tracking-widest uppercase transition-all"
          onClick={handleLogout}
        >
          DISCONNECT &amp; LOGOUT
        </button>

      </div>
    </MobileFrame>
  );
}

function SettingItem({ icon, title, description, action, hasChevron }) {
  return (
    <div className="flex items-center justify-between p-4 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors cursor-pointer active:bg-white/10">
      <div className="flex items-center gap-3">
        <div className="text-zinc-400">{icon}</div>
        <div>
          <p className="text-sm font-medium text-zinc-200">{title}</p>
          <p className="text-[10px] text-zinc-500">{description}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {action}
        {hasChevron && <ChevronRight size={16} className="text-zinc-600" />}
      </div>
    </div>
  );
}
