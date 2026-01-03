import { useState, useRef, useEffect, useCallback } from 'react';

export default function MobilePTTButton({ 
  onTransmitStart, 
  onTransmitEnd, 
  disabled,
  isTransmitting,
  isReceiving,
  activeSpeaker,
  theme
}) {
  const [isDenying, setIsDenying] = useState(false);
  const isActiveRef = useRef(false);
  const lastActionTimeRef = useRef(0);
  const buttonRef = useRef(null);

  const startTransmit = useCallback(() => {
    if (disabled) return;
    
    const now = Date.now();
    if (now - lastActionTimeRef.current < 100) return;
    if (isActiveRef.current) return;
    
    lastActionTimeRef.current = now;
    isActiveRef.current = true;
    
    if (window.navigator.vibrate) window.navigator.vibrate(50);
    onTransmitStart?.();
  }, [disabled, onTransmitStart]);

  const stopTransmit = useCallback(() => {
    if (!isActiveRef.current) return;
    
    isActiveRef.current = false;
    lastActionTimeRef.current = Date.now();
    onTransmitEnd?.();
  }, [onTransmitEnd]);

  useEffect(() => {
    const handleGlobalPointerUp = () => {
      if (isActiveRef.current) {
        stopTransmit();
      }
    };

    document.addEventListener('pointerup', handleGlobalPointerUp, { passive: true });
    document.addEventListener('pointercancel', handleGlobalPointerUp, { passive: true });
    document.addEventListener('touchend', handleGlobalPointerUp, { passive: true });
    document.addEventListener('touchcancel', handleGlobalPointerUp, { passive: true });

    return () => {
      document.removeEventListener('pointerup', handleGlobalPointerUp);
      document.removeEventListener('pointercancel', handleGlobalPointerUp);
      document.removeEventListener('touchend', handleGlobalPointerUp);
      document.removeEventListener('touchcancel', handleGlobalPointerUp);
    };
  }, [stopTransmit]);

  useEffect(() => {
    return () => {
      if (isActiveRef.current) {
        onTransmitEnd?.();
        isActiveRef.current = false;
      }
    };
  }, [onTransmitEnd]);

  const getButtonStyle = () => {
    const baseStyle = {
      width: '200px',
      height: '200px',
      borderRadius: '50%',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      border: '4px solid',
      transition: 'all 0.2s',
      cursor: disabled ? 'not-allowed' : 'pointer',
      touchAction: 'none',
      WebkitTouchCallout: 'none',
      WebkitUserSelect: 'none',
      userSelect: 'none',
    };

    if (disabled) {
      return {
        ...baseStyle,
        backgroundColor: '#27272a',
        borderColor: '#3f3f46',
        opacity: 0.5,
      };
    }

    if (isTransmitting) {
      return {
        ...baseStyle,
        backgroundColor: '#22c55e',
        borderColor: '#4ade80',
        boxShadow: '0 0 50px rgba(34, 197, 94, 0.6)',
      };
    }

    if (isReceiving) {
      return {
        ...baseStyle,
        backgroundColor: '#dc2626',
        borderColor: '#f87171',
        boxShadow: '0 0 50px rgba(239, 68, 68, 0.6)',
      };
    }

    return {
      ...baseStyle,
      backgroundColor: '#27272a',
      borderColor: '#3f3f46',
    };
  };

  const getIconColor = () => {
    if (isTransmitting || isReceiving) return '#fff';
    return '#71717a';
  };

  const getLabel = () => {
    if (isTransmitting) return 'TX ACTIVE';
    if (isReceiving) return activeSpeaker || 'RX ACTIVE';
    return 'HOLD TO TALK';
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <button
        ref={buttonRef}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
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
        onPointerCancel={stopTransmit}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
        onTouchStart={(e) => e.preventDefault()}
        onTouchMove={(e) => e.preventDefault()}
        style={getButtonStyle()}
        disabled={disabled}
      >
        <div style={{
          padding: '16px',
          borderRadius: '50%',
          border: '2px solid',
          borderColor: isTransmitting || isReceiving ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.1)',
          backgroundColor: isTransmitting || isReceiving ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.2)',
        }}>
          {isTransmitting ? (
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={getIconColor()} strokeWidth="2">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          ) : isReceiving ? (
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={getIconColor()} strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
            </svg>
          ) : (
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={getIconColor()} strokeWidth="2">
              <line x1="2" x2="22" y1="2" y2="22"/>
              <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/>
              <path d="M5 10v2a7 7 0 0 0 12 5"/>
              <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>
              <line x1="12" x2="12" y1="19" y2="22"/>
            </svg>
          )}
        </div>
        
        <span style={{
          marginTop: '16px',
          fontWeight: 'bold',
          letterSpacing: '0.1em',
          fontSize: '14px',
          textTransform: 'uppercase',
          color: isTransmitting || isReceiving ? '#fff' : '#71717a',
        }}>
          {getLabel()}
        </span>
      </button>
    </div>
  );
}
