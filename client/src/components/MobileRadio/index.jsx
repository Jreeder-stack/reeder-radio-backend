import { useState, useEffect, useRef, useCallback } from 'react';
import MobilePTTButton from './MobilePTTButton';
import { useLiveKitConnection } from '../../context/LiveKitConnectionContext';
import { micPTTManager } from '../../audio/MicPTTManager';
import { PTT_STATES } from '../../constants/pttStates';
import { updateUnitStatus } from '../../utils/api';
import { DataPacket_Kind } from 'livekit-client';

const THEMES = {
  dark: {
    bg: '#000',
    bgSecondary: '#18181b',
    bgTertiary: '#27272a',
    text: '#fff',
    textSecondary: '#a1a1aa',
    textMuted: '#71717a',
    border: '#3f3f46',
    accent: '#22c55e',
    danger: '#dc2626',
  },
  light: {
    bg: '#f4f4f5',
    bgSecondary: '#fff',
    bgTertiary: '#e4e4e7',
    text: '#18181b',
    textSecondary: '#52525b',
    textMuted: '#a1a1aa',
    border: '#d4d4d8',
    accent: '#22c55e',
    danger: '#dc2626',
  }
};

export default function MobileRadioView({ user, onLogout, darkMode, toggleDarkMode }) {
  const theme = darkMode ? THEMES.dark : THEMES.light;
  const identity = (user?.unit_id && user.unit_id.trim()) || user?.username || 'Unknown';
  
  const {
    livekitManager,
    connectionStatus,
    channels: contextChannels,
    switchChannel: contextSwitchChannel,
    ensureConnected,
  } = useLiveKitConnection();
  
  const connected = connectionStatus === 'connected';
  const connecting = connectionStatus === 'connecting';
  
  const [zonesData, setZonesData] = useState({});
  const [selectedZone, setSelectedZone] = useState('');
  const [selectedChannel, setSelectedChannel] = useState('');
  const [transmitChannel, setTransmitChannel] = useState('');
  const [isEmergency, setIsEmergency] = useState(false);
  const [pttState, setPttState] = useState(PTT_STATES.IDLE);
  const [activeAudio, setActiveAudio] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  
  const transmitChannelRef = useRef('');
  const isEmergencyRef = useRef(false);
  const rxAudioElementsRef = useRef(new Set());
  
  useEffect(() => {
    transmitChannelRef.current = transmitChannel;
  }, [transmitChannel]);
  
  useEffect(() => {
    isEmergencyRef.current = isEmergency;
  }, [isEmergency]);

  useEffect(() => {
    fetch('/api/zones')
      .then(res => res.json())
      .then(data => {
        if (data && typeof data === 'object') {
          setZonesData(data);
          const zoneNames = Object.keys(data);
          if (zoneNames.length > 0 && !selectedZone) {
            setSelectedZone(zoneNames[0]);
            const firstZoneChannels = data[zoneNames[0]] || [];
            if (firstZoneChannels.length > 0) {
              const channelName = firstZoneChannels[0].name || firstZoneChannels[0];
              setSelectedChannel(channelName);
              setTransmitChannel(channelName);
              contextSwitchChannel(channelName);
            }
          }
        }
      })
      .catch(err => console.error('Failed to load zones:', err));
  }, [selectedZone, contextSwitchChannel]);

  useEffect(() => {
    if (navigator.geolocation) {
      const watchId = navigator.geolocation.watchPosition(
        (position) => {
          setUserLocation({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        (error) => console.log('Geolocation error:', error.message),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
      );
      return () => navigator.geolocation.clearWatch(watchId);
    }
  }, []);

  useEffect(() => {
    if (!livekitManager) return;
    livekitManager.setAutoPlayback(false);
    
    const listenerRemovers = [];
    
    listenerRemovers.push(
      livekitManager.addTrackSubscribedListener((channelName, track, participant) => {
        if (track.kind !== 'audio') return;
        
        const audioElem = track.attach();
        audioElem.dataset.channel = channelName;
        audioElem.dataset.participant = participant.identity;
        audioElem.playsInline = true;
        audioElem.autoplay = true;
        audioElem.style.display = 'none';
        
        document.body.appendChild(audioElem);
        rxAudioElementsRef.current.add(audioElem);
        
        const currentState = micPTTManager.getState();
        if (currentState === PTT_STATES.TRANSMITTING || currentState === PTT_STATES.ARMING) {
          audioElem.muted = true;
        } else {
          audioElem.muted = false;
          audioElem.volume = 1.0;
        }
        
        audioElem.play().catch(() => {});
        setActiveAudio({ channel: channelName, from: participant.identity });
      })
    );
    
    listenerRemovers.push(
      livekitManager.addTrackUnsubscribedListener((channelName, track, participant) => {
        const detachedElements = track.detach();
        detachedElements.forEach((el) => {
          rxAudioElementsRef.current.delete(el);
          el.remove();
        });
        setActiveAudio(null);
      })
    );
    
    return () => {
      if (livekitManager) {
        livekitManager.setAutoPlayback(true);
      }
      listenerRemovers.forEach(remove => remove());
    };
  }, [livekitManager]);

  const broadcastStatus = useCallback((status, channel) => {
    const room = livekitManager?.getRoom(channel);
    if (!room || !room.localParticipant) return;
    
    const message = JSON.stringify({
      type: 'status_update',
      identity: room.localParticipant.identity,
      status,
      channel,
      timestamp: Date.now(),
    });
    
    const encoder = new TextEncoder();
    const data = encoder.encode(message);
    room.localParticipant.publishData(data, DataPacket_Kind.RELIABLE);
  }, [livekitManager]);

  useEffect(() => {
    micPTTManager.onStateChange = (newState) => {
      setPttState(newState);
      const txChannel = transmitChannelRef.current;
      
      if (newState === PTT_STATES.ARMING) {
        rxAudioElementsRef.current.forEach(el => { el.muted = true; });
      } else if (newState === PTT_STATES.TRANSMITTING) {
        rxAudioElementsRef.current.forEach(el => { el.muted = true; });
        if (txChannel) {
          broadcastStatus('transmitting', txChannel);
          updateUnitStatus(identity, txChannel, 'transmitting', userLocation, isEmergencyRef.current).catch(() => {});
        }
      } else if (newState === PTT_STATES.IDLE) {
        rxAudioElementsRef.current.forEach(el => { el.muted = false; });
        if (txChannel) {
          broadcastStatus('idle', txChannel);
          updateUnitStatus(identity, txChannel, 'idle', userLocation, isEmergencyRef.current).catch(() => {});
        }
      }
    };
    
    return () => {
      micPTTManager.disconnect();
    };
  }, [broadcastStatus, identity, userLocation]);

  const handlePTTStart = useCallback(async () => {
    if (!transmitChannel) return;
    
    await ensureConnected();
    const room = livekitManager?.getRoom(transmitChannel);
    if (!room) return;
    
    micPTTManager.start(room);
  }, [transmitChannel, ensureConnected, livekitManager]);

  const handlePTTEnd = useCallback(() => {
    if (!isEmergencyRef.current && micPTTManager.canStop()) {
      micPTTManager.stop();
    }
  }, []);

  const handleChannelChange = (e) => {
    const channelName = e.target.value;
    setSelectedChannel(channelName);
    setTransmitChannel(channelName);
    contextSwitchChannel(channelName);
  };

  const handleZoneChange = (e) => {
    const zoneName = e.target.value;
    setSelectedZone(zoneName);
    const zoneChannels = zonesData[zoneName] || [];
    if (zoneChannels.length > 0) {
      const channelName = zoneChannels[0].name || zoneChannels[0];
      setSelectedChannel(channelName);
      setTransmitChannel(channelName);
      contextSwitchChannel(channelName);
    }
  };

  const handleEmergencyToggle = () => {
    if (isEmergency) {
      setIsEmergency(false);
    } else {
      setIsEmergency(true);
      if (transmitChannel) {
        handlePTTStart();
      }
    }
  };

  const currentZoneChannels = zonesData[selectedZone] || [];
  const isTransmitting = pttState === PTT_STATES.TRANSMITTING;
  const isReceiving = !!activeAudio;

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: theme.bg,
      color: theme.text,
      display: 'flex',
      flexDirection: 'column',
    }}>
      <header style={{
        backgroundColor: theme.bgSecondary,
        borderBottom: `1px solid ${theme.border}`,
        padding: '12px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontWeight: 'bold', fontSize: '16px', letterSpacing: '0.05em' }}>
            COMMAND COMMS
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}>
            <div style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              backgroundColor: connected ? theme.accent : connecting ? '#eab308' : theme.danger,
            }} />
            <span style={{ fontSize: '10px', fontWeight: 'bold', letterSpacing: '0.1em', color: theme.textSecondary }}>
              {connected ? 'ONLINE' : connecting ? 'CONNECTING' : 'OFFLINE'}
            </span>
          </div>
          <button
            onClick={toggleDarkMode}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: '18px',
            }}
          >
            {darkMode ? '☀️' : '🌙'}
          </button>
          <button
            onClick={onLogout}
            style={{
              backgroundColor: theme.danger,
              color: '#fff',
              border: 'none',
              padding: '6px 12px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <div style={{
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}>
        <div style={{
          display: 'flex',
          gap: '8px',
        }}>
          <select
            value={selectedZone}
            onChange={handleZoneChange}
            style={{
              flex: 1,
              backgroundColor: theme.bgTertiary,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: '8px',
              padding: '12px',
              fontSize: '14px',
              fontWeight: 'bold',
            }}
          >
            {Object.keys(zonesData).map(zoneName => (
              <option key={zoneName} value={zoneName}>{zoneName}</option>
            ))}
          </select>
          <select
            value={selectedChannel}
            onChange={handleChannelChange}
            style={{
              flex: 1,
              backgroundColor: theme.bgTertiary,
              color: theme.text,
              border: `1px solid ${theme.border}`,
              borderRadius: '8px',
              padding: '12px',
              fontSize: '14px',
              fontWeight: 'bold',
            }}
          >
            {currentZoneChannels.map((ch, idx) => {
              const channelName = ch.name || ch;
              return (
                <option key={idx} value={channelName}>{channelName}</option>
              );
            })}
          </select>
        </div>

        <div style={{
          textAlign: 'center',
          padding: '8px',
          backgroundColor: theme.bgSecondary,
          borderRadius: '8px',
          border: `1px solid ${theme.border}`,
        }}>
          <span style={{ fontSize: '12px', color: theme.textMuted }}>TX: </span>
          <span style={{ fontSize: '14px', fontWeight: 'bold' }}>{transmitChannel || 'None'}</span>
          <span style={{ fontSize: '12px', color: theme.textMuted }}> | RX: </span>
          <span style={{ fontSize: '14px', fontWeight: 'bold' }}>{selectedChannel || 'None'}</span>
        </div>
      </div>

      <button
        onClick={handleEmergencyToggle}
        style={{
          margin: '0 16px',
          padding: '14px',
          backgroundColor: isEmergency ? theme.danger : '#7f1d1d',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          fontSize: '16px',
          fontWeight: 'bold',
          letterSpacing: '0.1em',
          cursor: 'pointer',
          animation: isEmergency ? 'pulse 1s infinite' : 'none',
        }}
      >
        {isEmergency ? '🚨 EMERGENCY ACTIVE' : 'EMERGENCY'}
      </button>

      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        minHeight: '300px',
      }}>
        <MobilePTTButton
          onTransmitStart={handlePTTStart}
          onTransmitEnd={handlePTTEnd}
          disabled={!connected || !transmitChannel}
          isTransmitting={isTransmitting}
          isReceiving={isReceiving}
          activeSpeaker={activeAudio?.from}
          theme={theme}
        />
        
        <div style={{
          marginTop: '24px',
          textAlign: 'center',
        }}>
          <p style={{
            fontSize: '12px',
            color: isEmergency ? theme.danger : theme.textMuted,
            fontWeight: isEmergency ? 'bold' : 'normal',
            letterSpacing: '0.1em',
          }}>
            {isEmergency ? 'EMERGENCY DECLARED' : 
             connected ? 'Press and hold to transmit' : 
             connecting ? 'Connecting...' : 'Waiting for connection'}
          </p>
          
          {userLocation && (
            <p style={{
              marginTop: '8px',
              fontSize: '10px',
              color: theme.accent,
            }}>
              📍 GPS Active
            </p>
          )}
        </div>
      </div>

      <div style={{
        backgroundColor: theme.bgSecondary,
        borderTop: `1px solid ${theme.border}`,
        padding: '16px',
      }}>
        <div style={{
          fontSize: '12px',
          color: theme.textMuted,
          textAlign: 'center',
        }}>
          Unit: <span style={{ fontWeight: 'bold', color: theme.text }}>{identity}</span>
        </div>
      </div>

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.7; }
        }
      `}</style>
    </div>
  );
}
