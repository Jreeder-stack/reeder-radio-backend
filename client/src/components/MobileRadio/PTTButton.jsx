import { Mic, MicOff, Ban, Volume2 } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "../../lib/utils";
import { playTalkPermitTone } from "../../lib/audioTones";

export function PTTButton({ 
  onTransmitStart, 
  onTransmitEnd, 
  disabled = false,
  isConnected = true,
  channelStatus = 'clear',
  isReceiving = false,
  activeSpeaker = null,
  isTransmitting = false,
  setTransmitting
}) {
  const [isDenying, setIsDenying] = useState(false);
  const audioContextRef = useRef(null);
  const busyOscillatorRef = useRef(null);
  const busyGainRef = useRef(null);
  const isActiveRef = useRef(false);
  const lastActionTimeRef = useRef(0);
  const buttonRef = useRef(null);
  const activePointerIdRef = useRef(null);
  
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
      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

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
    const playBeep = (freq, startTime) => {
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
    if (disabled || !isConnected) return;
    
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
      playTalkPermitTone();
      if (setTransmitting) setTransmitting(true);
      onTransmitStartRef.current?.();
    }
  };

  const stopTransmit = useCallback(() => {
    if (!isActiveRef.current) return;
    
    console.log('[PTT] stopTransmit called');
    isActiveRef.current = false;
    lastActionTimeRef.current = Date.now();
    
    const pointerId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    
    if (buttonRef.current && pointerId !== null) {
      try {
        buttonRef.current.releasePointerCapture(pointerId);
      } catch (e) {}
    }
    
    const status = channelStatusRef.current;
    if (status === 'busy') {
      stopBusyTone();
    } else if (status === 'error') {
      setIsDenying(false);
    } else {
      if (setTransmitting) setTransmitting(false);
      onTransmitEndRef.current?.();
    }
  }, [setTransmitting]);

  useEffect(() => {
    const handleGlobalPointerUp = (e) => {
      if (isActiveRef.current) {
        console.log('[PTT] Global pointerup detected, stopping transmit');
        stopTransmit();
      }
    };

    const handleGlobalTouchEnd = (e) => {
      if (isActiveRef.current) {
        console.log('[PTT] Global touchend detected, stopping transmit');
        stopTransmit();
      }
    };

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
      if (isActiveRef.current) {
        if (setTransmitting) setTransmitting(false);
        onTransmitEndRef.current?.();
        isActiveRef.current = false;
      }
      if (audioContextRef.current?.state === 'running') {
        audioContextRef.current.suspend();
      }
    };
  }, [setTransmitting]);

  const getButtonLabel = () => {
    if (!isConnected) return 'CONNECTING...';
    if (isTransmitting) return 'TX ACTIVE';
    if (isReceiving) return activeSpeaker || 'RX ACTIVE';
    if (isDenying) return 'BUSY';
    return 'HOLD TO TALK';
  };

  return (
    <div className="relative flex items-center justify-center select-none">
      <button
        ref={buttonRef}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          activePointerIdRef.current = e.pointerId;
          try {
            buttonRef.current?.setPointerCapture(e.pointerId);
          } catch (err) {}
          startTransmit();
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          e.stopPropagation();
          stopTransmit();
        }}
        onPointerCancel={(e) => {
          stopTransmit();
        }}
        onLostPointerCapture={(e) => {
          if (isActiveRef.current) {
            stopTransmit();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onTouchStart={(e) => {
          e.preventDefault();
        }}
        onTouchMove={(e) => {
          e.preventDefault();
        }}
        style={{
          touchAction: 'none',
          WebkitTouchCallout: 'none',
          WebkitUserSelect: 'none',
          userSelect: 'none',
        }}
        className={cn(
          "relative w-full h-32 rounded-lg flex flex-col items-center justify-center transition-all duration-200 shadow-lg z-10",
          disabled || !isConnected
            ? "bg-gray-300 border-2 border-gray-400 cursor-not-allowed opacity-50" 
            : isTransmitting
              ? "bg-cyan-500 border-2 border-cyan-300 shadow-[0_0_30px_rgba(6,182,212,0.6)]"
              : isReceiving
                ? "bg-red-500 border-2 border-red-400 shadow-[0_0_30px_rgba(239,68,68,0.6)]"
                : isDenying
                  ? "bg-red-200 border-2 border-red-400"
                  : "bg-gray-200 border-2 border-gray-400 active:bg-gray-300"
        )}
        data-testid="button-ptt"
      >
        {isTransmitting ? (
          <Mic className="w-10 h-10 text-white" />
        ) : isReceiving ? (
          <Volume2 className="w-10 h-10 text-white animate-pulse" />
        ) : isDenying ? (
          <Ban className="w-10 h-10 text-red-600" />
        ) : (
          <Mic className="w-10 h-10 text-gray-600" />
        )}
        
        <span className={cn(
          "mt-2 font-bold tracking-wide text-base uppercase",
          isTransmitting ? "text-white" : isReceiving ? "text-white" : isDenying ? "text-red-600" : "text-gray-700"
        )}>
          {getButtonLabel()}
        </span>
      </button>
    </div>
  );
}
