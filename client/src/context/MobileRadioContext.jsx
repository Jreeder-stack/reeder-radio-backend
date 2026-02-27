import { createContext, useContext, useState, useCallback, useEffect } from 'react';

const SCAN_CHANNELS_KEY = 'radio_scan_channels';
const SCAN_ACTIVE_KEY = 'radio_scan_active';

const MobileRadioContext = createContext(null);

export function MobileRadioProvider({ children }) {
  const [isScanning, setIsScanning] = useState(() => {
    try {
      return localStorage.getItem(SCAN_ACTIVE_KEY) === 'true';
    } catch { return false; }
  });
  const [isEmergency, setIsEmergency] = useState(false);
  const [scanChannels, setScanChannels] = useState(() => {
    try {
      const saved = localStorage.getItem(SCAN_CHANNELS_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  const toggleScanning = useCallback(() => {
    setIsScanning(prev => !prev);
  }, []);

  const triggerEmergency = useCallback(async () => {
    setIsEmergency(true);
    
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const now = audioContext.currentTime;
    const volume = 0.7;
    const beepDuration = 0.1;
    const beepGap = 0.05;
    
    const frequencies = [1800, 2200, 1800];
    
    frequencies.forEach((freq, index) => {
      const startTime = now + index * (beepDuration + beepGap);
      
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      
      osc.connect(gain);
      gain.connect(audioContext.destination);
      
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(volume, startTime);
      gain.gain.setValueAtTime(0, startTime + beepDuration);
      
      osc.start(startTime);
      osc.stop(startTime + beepDuration);
    });
  }, []);

  const cancelEmergency = useCallback(async () => {
    setIsEmergency(false);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SCAN_CHANNELS_KEY, JSON.stringify(scanChannels));
    } catch {}
  }, [scanChannels]);

  useEffect(() => {
    try {
      localStorage.setItem(SCAN_ACTIVE_KEY, isScanning ? 'true' : 'false');
    } catch {}
  }, [isScanning]);

  const toggleScanChannel = useCallback((channelId) => {
    setScanChannels(prev => 
      prev.map(ch => 
        ch.id === channelId ? { ...ch, enabled: !ch.enabled } : ch
      )
    );
  }, []);

  const value = {
    isScanning,
    setIsScanning,
    toggleScanning,
    isEmergency,
    setIsEmergency,
    triggerEmergency,
    cancelEmergency,
    scanChannels,
    setScanChannels,
    toggleScanChannel,
  };

  return (
    <MobileRadioContext.Provider value={value}>
      {children}
    </MobileRadioContext.Provider>
  );
}

export function useMobileRadioContext() {
  const context = useContext(MobileRadioContext);
  if (!context) {
    throw new Error('useMobileRadioContext must be used within MobileRadioProvider');
  }
  return context;
}
