import { Mic, MicOff, Ban, Volume2 } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "../../lib/utils";
import { playTalkPermitTone } from "../../lib/audioTones";
import { isIOS } from "../../lib/platform";
import { getSharedAudioContext } from "../../audio/iosAudioUnlock";

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
  const busyOscillatorRef = useRef(null);
  const busyGainRef = useRef(null);
  const isActiveRef = useRef(false);
  const lastActionTimeRef = useRef(0);
  const buttonRef = useRef(null);
  const activePointerIdRef = useRef(null);
  const lastInputAtRef = useRef(0);
  
  const onTransmitStartRef = useRef(onTransmitStart);
  const onTransmitEndRef = useRef(onTransmitEnd);
  const channelStatusRef = useRef(channelStatus);
  
  useEffect(() => {
    onTransmitStartRef.current = onTransmitStart;
    onTransmitEndRef.current = onTransmitEnd;
    channelStatusRef.current = channelStatus;
  }, [onTransmitStart, onTransmitEnd, channelStatus]);

  const startBusyTone = () => {
    const ctx = getSharedAudioContext();
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
    const ctx = getSharedAudioContext();
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

  const startTransmit = async () => {
    if (disabled) return;
    
    const now = Date.now();
    if (now - lastActionTimeRef.current < 100) return;
    if (isActiveRef.current) return;
    
    lastActionTimeRef.current = now;
    isActiveRef.current = true;
    
    if (window.navigator.vibrate) window.navigator.vibrate(50);

    if (!isConnected) {
      if (setTransmitting) setTransmitting(true);
      onTransmitStartRef.current?.();
      return;
    }

    const status = channelStatusRef.current;
    if (status === 'busy') {
      startBusyTone();
    } else if (status === 'error') {
      playErrorTone();
      setIsDenying(true);
    } else {
      await playTalkPermitTone();
      if (!isActiveRef.current) return;
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

  // iOS Safari fallback: attach native touch listeners with passive:false so we
  // can preventDefault() and suppress the iOS callout/scroll/double-tap zoom.
  // Pointer Events handle the actual start/stop on modern iOS, so this is
  // de-duplicated by `lastInputAtRef`.
  useEffect(() => {
    if (!isIOS()) return;
    const btn = buttonRef.current;
    if (!btn) return;

    const recentlyHandled = () => {
      return Date.now() - lastInputAtRef.current < 250;
    };

    const handleTouchStart = (e) => {
      e.preventDefault();
      if (recentlyHandled()) return;
      lastInputAtRef.current = Date.now();
      startTransmit();
    };
    const handleTouchEnd = (e) => {
      e.preventDefault();
      lastInputAtRef.current = Date.now();
      stopTransmit();
    };
    const handleTouchCancel = () => {
      lastInputAtRef.current = Date.now();
      stopTransmit();
    };

    btn.addEventListener('touchstart', handleTouchStart, { passive: false });
    btn.addEventListener('touchend', handleTouchEnd, { passive: false });
    btn.addEventListener('touchcancel', handleTouchCancel, { passive: false });

    return () => {
      btn.removeEventListener('touchstart', handleTouchStart);
      btn.removeEventListener('touchend', handleTouchEnd);
      btn.removeEventListener('touchcancel', handleTouchCancel);
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
      // AudioContext is shared (see iosAudioUnlock.getSharedAudioContext) — do not suspend/close here.
    };
  }, [setTransmitting]);

  const showBusy = isDenying || (!isTransmitting && !isReceiving && channelStatus === 'busy');

  const getButtonLabel = () => {
    if (!isConnected) return 'CONNECTING...';
    if (isTransmitting) return 'TX ACTIVE';
    if (isReceiving) return activeSpeaker || 'RX ACTIVE';
    if (showBusy) return 'BUSY';
    return 'HOLD TO TALK';
  };

  return (
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
      style={{
        touchAction: 'none',
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
      }}
      className={cn(
        "w-full rounded-lg p-4 flex items-center justify-center gap-2 font-bold text-sm uppercase tracking-wider transition-all active:scale-98 select-none",
        disabled || !isConnected
          ? "bg-gray-200 border border-gray-300 text-gray-400 cursor-not-allowed" 
          : isTransmitting
            ? "bg-cyan-500 text-white shadow-lg"
            : isReceiving
              ? "bg-red-500 text-white shadow-lg"
              : showBusy
                ? "bg-red-200 border border-red-400 text-red-600"
                : "bg-white border border-gray-200 text-cyan-600 shadow-sm"
      )}
      data-testid="button-ptt"
    >
      {isTransmitting ? (
        <Mic className="w-5 h-5" />
      ) : isReceiving ? (
        <Volume2 className="w-5 h-5 animate-pulse" />
      ) : showBusy ? (
        <Ban className="w-5 h-5" />
      ) : (
        <Mic className="w-5 h-5" />
      )}
      {getButtonLabel()}
    </button>
  );
}
