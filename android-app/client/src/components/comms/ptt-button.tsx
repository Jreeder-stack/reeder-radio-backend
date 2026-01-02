import { motion } from "framer-motion";
import { Mic, MicOff, Ban, Volume2 } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useRadio } from "@/lib/radio-context";

interface PTTButtonProps {
  onTransmitStart?: () => void;
  onTransmitEnd?: () => void;
  disabled?: boolean;
  channelStatus?: 'clear' | 'busy' | 'error';
  isReceiving?: boolean;
  activeSpeaker?: string | null;
}

export function PTTButton({ 
  onTransmitStart, 
  onTransmitEnd, 
  disabled,
  channelStatus = 'clear',
  isReceiving = false,
  activeSpeaker = null
}: PTTButtonProps) {
  const { isTransmitting: globalIsTransmitting, setTransmitting } = useRadio();
  const [isDenying, setIsDenying] = useState(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const busyOscillatorRef = useRef<OscillatorNode | null>(null);
  const busyGainRef = useRef<GainNode | null>(null);
  const isActiveRef = useRef(false);
  const lastActionTimeRef = useRef(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  
  const onTransmitStartRef = useRef(onTransmitStart);
  const onTransmitEndRef = useRef(onTransmitEnd);
  const channelStatusRef = useRef(channelStatus);
  
  useEffect(() => {
    onTransmitStartRef.current = onTransmitStart;
    onTransmitEndRef.current = onTransmitEnd;
    channelStatusRef.current = channelStatus;
  }, [onTransmitStart, onTransmitEnd, channelStatus]);

  const initAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  // Talk permit tone is now played from useLiveKit after transmission is established

  const startBusyTone = () => {
    const ctx = initAudioContext();
    const volume = 0.4;
    if (busyOscillatorRef.current) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(480, ctx.currentTime);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    osc.start();
    busyOscillatorRef.current = osc;
    busyGainRef.current = gain;
    setIsDenying(true);
  };

  const stopBusyTone = () => {
    if (busyOscillatorRef.current) {
      try {
        busyOscillatorRef.current.stop();
        busyOscillatorRef.current.disconnect();
      } catch (e) {}
      busyOscillatorRef.current = null;
    }
    if (busyGainRef.current) {
      busyGainRef.current.disconnect();
      busyGainRef.current = null;
    }
    setIsDenying(false);
  };

  const playErrorTone = () => {
    const ctx = initAudioContext();
    const now = ctx.currentTime;
    const volume = 0.4;
    const playBeep = (freq: number, startTime: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(volume, startTime);
      osc.start(startTime);
      osc.stop(startTime + 0.1);
    };
    playBeep(800, now);
    playBeep(600, now + 0.15);
    playBeep(400, now + 0.30);
  };

  const startTransmit = () => {
    if (disabled) return;
    
    const now = Date.now();
    if (now - lastActionTimeRef.current < 100) return;
    if (isActiveRef.current) return;
    
    lastActionTimeRef.current = now;
    isActiveRef.current = true;
    
    if (window.navigator.vibrate) window.navigator.vibrate(50);

    const status = channelStatusRef.current;
    if (status === 'busy') {
      startBusyTone();
    } else if (status === 'error') {
      playErrorTone();
      setIsDenying(true);
    } else {
      setTransmitting(true);
      // Talk permit tone is played from useLiveKit after transmission is established
      onTransmitStartRef.current?.();
    }
  };

  const stopTransmit = useCallback(() => {
    if (!isActiveRef.current) return;
    
    console.log('[PTT] stopTransmit called');
    isActiveRef.current = false;
    activePointerIdRef.current = null;
    lastActionTimeRef.current = Date.now();
    
    // Release pointer capture if we have it
    if (buttonRef.current) {
      try {
        // Release all pointer captures
        buttonRef.current.releasePointerCapture(-1);
      } catch (e) {
        // Ignore - may not have capture
      }
    }
    
    const status = channelStatusRef.current;
    if (status === 'busy') {
      stopBusyTone();
    } else if (status === 'error') {
      setIsDenying(false);
    } else {
      setTransmitting(false);
      onTransmitEndRef.current?.();
    }
  }, [setTransmitting]);

  // Global pointer up listener as fallback - ensures release even if event is missed
  useEffect(() => {
    const handleGlobalPointerUp = (e: PointerEvent) => {
      if (isActiveRef.current) {
        console.log('[PTT] Global pointerup detected, stopping transmit');
        stopTransmit();
      }
    };

    const handleGlobalTouchEnd = (e: TouchEvent) => {
      if (isActiveRef.current) {
        console.log('[PTT] Global touchend detected, stopping transmit');
        stopTransmit();
      }
    };

    // Add global listeners
    document.addEventListener('pointerup', handleGlobalPointerUp, { passive: true });
    document.addEventListener('pointercancel', handleGlobalPointerUp, { passive: true });
    document.addEventListener('touchend', handleGlobalTouchEnd, { passive: true });
    document.addEventListener('touchcancel', handleGlobalTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('pointerup', handleGlobalPointerUp);
      document.removeEventListener('pointercancel', handleGlobalPointerUp);
      document.removeEventListener('touchend', handleGlobalTouchEnd);
      document.removeEventListener('touchcancel', handleGlobalTouchEnd);
    };
  }, [stopTransmit]);

  useEffect(() => {
    return () => {
      stopBusyTone();
      // Ensure we stop transmit on unmount
      if (isActiveRef.current) {
        setTransmitting(false);
        onTransmitEndRef.current?.();
        isActiveRef.current = false;
      }
      if (audioContextRef.current?.state === 'running') {
        audioContextRef.current.suspend();
      }
    };
  }, [setTransmitting]);

  return (
    <div className="relative flex items-center justify-center select-none">
      <motion.button
        ref={buttonRef}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          console.log('[PTT] pointerdown, pointerId:', e.pointerId);
          activePointerIdRef.current = e.pointerId;
          // Capture pointer to ensure we get all events even if finger moves
          try {
            buttonRef.current?.setPointerCapture(e.pointerId);
          } catch (err) {
            console.log('[PTT] setPointerCapture failed:', err);
          }
          startTransmit();
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          e.stopPropagation();
          console.log('[PTT] pointerup, pointerId:', e.pointerId);
          stopTransmit();
        }}
        onPointerCancel={(e) => {
          console.log('[PTT] pointercancel, pointerId:', e.pointerId);
          stopTransmit();
        }}
        onLostPointerCapture={(e) => {
          // This fires when pointer capture is lost for any reason
          console.log('[PTT] lostpointercapture, pointerId:', e.pointerId);
          if (isActiveRef.current) {
            stopTransmit();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onTouchStart={(e) => {
          // Prevent default touch behaviors like scrolling
          e.preventDefault();
        }}
        onTouchMove={(e) => {
          // Prevent scroll during PTT hold
          e.preventDefault();
        }}
        whileTap={{ scale: 0.95 }}
        style={{
          touchAction: 'none',
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        }}
        className={cn(
          "relative w-48 h-48 rounded-full flex flex-col items-center justify-center transition-all duration-200 shadow-2xl z-10",
          disabled 
            ? "bg-zinc-800 border-4 border-zinc-700 cursor-not-allowed opacity-50" 
            : globalIsTransmitting
              ? "bg-primary border-4 border-primary-foreground shadow-[0_0_50px_rgba(6,182,212,0.6)]"
              : isReceiving
                ? "bg-red-600 border-4 border-red-400 shadow-[0_0_50px_rgba(239,68,68,0.6)]"
                : isDenying
                  ? "bg-red-900/20 border-4 border-red-500 shadow-[0_0_50px_rgba(239,68,68,0.4)]"
                  : "bg-zinc-800 border-4 border-zinc-700 hover:border-primary/50 hover:bg-zinc-750"
        )}
        data-testid="button-ptt"
      >
        <div className={cn(
          "p-4 rounded-full border-2 transition-colors duration-200",
          globalIsTransmitting ? "bg-white/20 border-white/50" : 
          isReceiving ? "bg-white/20 border-white/50" :
          isDenying ? "bg-red-500/20 border-red-500/50" : "bg-black/20 border-white/10"
        )}>
          {globalIsTransmitting ? (
            <Mic className={cn("w-12 h-12 text-white animate-pulse")} />
          ) : isReceiving ? (
            <Volume2 className="w-12 h-12 text-white animate-pulse" />
          ) : isDenying ? (
            <Ban className="w-12 h-12 text-red-500" />
          ) : (
            <MicOff className="w-12 h-12 text-zinc-500" />
          )}
        </div>
        
        <span className={cn(
          "mt-4 font-display font-bold tracking-widest text-lg uppercase",
          globalIsTransmitting ? "text-white" : isReceiving ? "text-white" : isDenying ? "text-red-500" : "text-zinc-500"
        )}>
          {globalIsTransmitting ? "TX ACTIVE" : isReceiving ? (activeSpeaker || "RX ACTIVE") : isDenying ? "BUSY" : "HOLD TO TALK"}
        </span>
      </motion.button>
    </div>
  );
}
