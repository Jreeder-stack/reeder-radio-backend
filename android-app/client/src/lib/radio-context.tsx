import { createContext, useContext, useState, useRef, ReactNode } from "react";
import { apiClient } from "./api-client";

export interface ScanChannel {
  id: string;
  name: string;
  enabled: boolean;
}

interface RadioState {
  isScanning: boolean;
  toggleScanning: () => void;
  isEmergency: boolean;
  triggerEmergency: () => Promise<void>;
  cancelEmergency: () => Promise<void>;
  isTransmitting: boolean;
  setTransmitting: (state: boolean) => void;
  scanChannels: ScanChannel[];
  setScanChannels: (channels: ScanChannel[] | ((prev: ScanChannel[]) => ScanChannel[])) => void;
  toggleScanChannel: (id: string) => void;
}

const RadioContext = createContext<RadioState | undefined>(undefined);

export function RadioProvider({ children }: { children: ReactNode }) {
  const [isScanning, setIsScanning] = useState(false);
  const [isEmergency, setIsEmergency] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [scanChannels, setScanChannels] = useState<ScanChannel[]>([]);
  
  const audioContextRef = useRef<AudioContext | null>(null);

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  const playEmergencyTone = () => {
    const ctx = initAudioContext();
    const now = ctx.currentTime;
    const volume = 0.7;
    const beepDuration = 0.1;
    const beepGap = 0.05;
    
    const frequencies = [1800, 2200, 1800];
    
    frequencies.forEach((freq, index) => {
      const startTime = now + index * (beepDuration + beepGap);
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(volume, startTime);
      gain.gain.setValueAtTime(0, startTime + beepDuration);
      
      osc.start(startTime);
      osc.stop(startTime + beepDuration);
    });
  };

  const toggleScanning = () => setIsScanning(prev => !prev);

  const toggleScanChannel = (id: string) => {
    setScanChannels(prev => prev.map(ch => 
      ch.id === id ? { ...ch, enabled: !ch.enabled } : ch
    ));
  };

  const triggerEmergency = async () => {
    setIsEmergency(true);
    playEmergencyTone();
    
    // Notify backend of emergency
    try {
      await apiClient.triggerEmergency();
    } catch (err) {
      console.error('Failed to trigger emergency on backend:', err);
    }
  };

  const cancelEmergency = async () => {
    setIsEmergency(false);
    setIsTransmitting(false);
    
    // Notify backend to cancel emergency
    try {
      await apiClient.cancelEmergency();
    } catch (err) {
      console.error('Failed to cancel emergency on backend:', err);
    }
  };

  return (
    <RadioContext.Provider value={{
      isScanning,
      toggleScanning,
      isEmergency,
      triggerEmergency,
      cancelEmergency,
      isTransmitting,
      setTransmitting: setIsTransmitting,
      scanChannels,
      setScanChannels,
      toggleScanChannel
    }}>
      {children}
    </RadioContext.Provider>
  );
}

export function useRadio() {
  const context = useContext(RadioContext);
  if (context === undefined) {
    throw new Error("useRadio must be used within a RadioProvider");
  }
  return context;
}
