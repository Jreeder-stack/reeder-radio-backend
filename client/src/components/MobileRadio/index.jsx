import { useState, useEffect, useRef, useCallback } from 'react';
import { MobileFrame } from './MobileFrame';
import { PTTButton } from './PTTButton';
import { PresenceList } from './PresenceList';
import { AlertTriangle, Activity, Loader2, Wifi, WifiOff, MapPin } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLiveKitConnection } from '../../context/LiveKitConnectionContext';
import { micPTTManager } from '../../audio/MicPTTManager';
import { PTT_STATES } from '../../constants/pttStates';
import { updateUnitStatus } from '../../utils/api';
import { DataPacket_Kind } from 'livekit-client';

export default function MobileRadioView({ user, onLogout }) {
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
  
  const [channels, setChannels] = useState([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [currentChannel, setCurrentChannel] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [isEmergency, setIsEmergency] = useState(false);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [pttState, setPttState] = useState(PTT_STATES.IDLE);
  const [activeAudio, setActiveAudio] = useState(null);
  const [userLocation, setUserLocation] = useState(null);
  const [unitPresence, setUnitPresence] = useState([]);
  
  const transmitChannelRef = useRef('');
  const isEmergencyRef = useRef(false);
  const rxAudioElementsRef = useRef(new Set());
  const hasJoinedRef = useRef(false);
  
  useEffect(() => {
    transmitChannelRef.current = currentChannel ? 
      channels.find(ch => String(ch.id) === currentChannel)?.name || '' : '';
  }, [currentChannel, channels]);
  
  useEffect(() => {
    isEmergencyRef.current = isEmergency;
  }, [isEmergency]);

  useEffect(() => {
    fetch('/api/channels')
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setChannels(data);
          if (data.length > 0) {
            setCurrentChannel(String(data[0].id));
          }
        }
        setChannelsLoading(false);
      })
      .catch(err => {
        console.error('Failed to load channels:', err);
        setChannelsLoading(false);
      });
  }, []);

  useEffect(() => {
    if (currentChannel && !hasJoinedRef.current && channels.length > 0) {
      hasJoinedRef.current = true;
      const channel = channels.find(ch => String(ch.id) === currentChannel);
      if (channel) {
        contextSwitchChannel(channel.name);
      }
    }
  }, [currentChannel, channels, contextSwitchChannel]);

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
        setIsTransmitting(true);
        rxAudioElementsRef.current.forEach(el => { el.muted = true; });
        if (txChannel) {
          broadcastStatus('transmitting', txChannel);
          updateUnitStatus(identity, txChannel, 'transmitting', userLocation, isEmergencyRef.current).catch(() => {});
        }
      } else if (newState === PTT_STATES.IDLE) {
        setIsTransmitting(false);
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

  const handleTransmitStart = useCallback(async () => {
    const channelName = transmitChannelRef.current;
    if (!channelName) return;
    
    await ensureConnected();
    const room = livekitManager?.getRoom(channelName);
    if (!room) return;
    
    micPTTManager.start(room);
  }, [ensureConnected, livekitManager]);

  const handleTransmitEnd = useCallback(() => {
    if (!isEmergencyRef.current && micPTTManager.canStop()) {
      micPTTManager.stop();
    }
  }, []);

  const handleChannelChange = (channelId) => {
    setCurrentChannel(channelId);
    const channel = channels.find(ch => String(ch.id) === channelId);
    if (channel) {
      contextSwitchChannel(channel.name);
    }
  };

  const toggleScanning = () => {
    setIsScanning(prev => !prev);
  };

  const playEmergencyTone = () => {
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
  };

  const handleEmergencyToggle = async () => {
    const channelName = transmitChannelRef.current || 'DISPATCH';
    
    if (isEmergency) {
      setIsEmergency(false);
      try {
        await fetch('/api/dispatch/emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ channel: channelName, active: false }),
        });
        console.log('[Emergency] Cancelled and notified dispatcher');
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher of cancellation:', err);
      }
    } else {
      setIsEmergency(true);
      playEmergencyTone();
      try {
        await fetch('/api/dispatch/emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ channel: channelName, active: true }),
        });
        console.log('[Emergency] Triggered and notified dispatcher');
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher:', err);
      }
    }
  };

  const currentChannelName = channels.find(ch => String(ch.id) === currentChannel)?.name || null;
  const isReceiving = !!activeAudio;
  const liveKitParticipants = [];

  return (
    <MobileFrame title="COMMUNICATIONS" connectionStatus={connectionStatus}>
      <div className="h-full flex flex-col p-4 gap-4">
        
        <div className="flex gap-2">
          <div className="flex-1 bg-zinc-900/50 p-4 rounded-xl border border-white/5 flex flex-col gap-2 relative overflow-hidden">
            <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Active Channel</label>
            <select 
              value={currentChannel} 
              onChange={(e) => handleChannelChange(e.target.value)}
              disabled={channelsLoading}
              className="h-12 bg-black/40 border border-zinc-700 text-white font-mono font-bold text-lg tracking-wider rounded-md px-3 focus:ring-primary/50 focus:border-primary/50 focus:outline-none"
            >
              {channelsLoading ? (
                <option>Loading...</option>
              ) : (
                channels.map((ch) => (
                  <option key={String(ch.id)} value={String(ch.id)} className="bg-zinc-900">
                    {ch.name}
                  </option>
                ))
              )}
            </select>
          </div>

          <button
            onClick={toggleScanning}
            className={cn(
              "w-20 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all active:scale-95 shadow-lg",
              isScanning 
                ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]" 
                : "bg-zinc-900/50 border-white/5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
            )}
          >
            {isScanning ? (
              <>
                <div className="relative">
                  <Activity className="w-8 h-8 animate-pulse" />
                  <div className="absolute inset-0 bg-emerald-500/20 blur-md rounded-full animate-pulse" />
                </div>
                <span className="text-[10px] font-bold tracking-wider">SCANNING</span>
              </>
            ) : (
              <>
                <Activity className="w-8 h-8" />
                <span className="text-[10px] font-bold tracking-wider">SCAN</span>
              </>
            )}
          </button>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center min-h-[250px] relative">
          <button
            onClick={handleEmergencyToggle}
            className={cn(
              "absolute top-0 right-0 z-20 transition-all duration-300 font-bold tracking-widest px-3 py-2 rounded-md flex items-center gap-2 text-sm",
              isEmergency 
                ? "animate-pulse shadow-[0_0_20px_rgba(239,68,68,0.6)] bg-red-600 hover:bg-red-700 text-white" 
                : "opacity-80 hover:opacity-100 bg-red-900/50 text-red-400 border border-red-500/30"
            )}
          >
            <AlertTriangle className="h-4 w-4" />
            {isEmergency ? "EMERGENCY ACTIVE" : "EMERGENCY"}
          </button>

          <PTTButton 
            channelStatus={connected ? "clear" : connecting ? "busy" : "error"}
            onTransmitStart={handleTransmitStart}
            onTransmitEnd={handleTransmitEnd}
            disabled={!connected}
            isReceiving={isReceiving}
            activeSpeaker={activeAudio?.from}
            isTransmitting={isTransmitting}
            setTransmitting={setIsTransmitting}
          />
          
          <div className="mt-8 text-center space-y-3">
            <div className="flex items-center justify-center gap-2">
              {connecting ? (
                <Loader2 className="w-4 h-4 text-yellow-500 animate-spin" />
              ) : connected ? (
                <Wifi className="w-4 h-4 text-emerald-500" />
              ) : (
                <WifiOff className="w-4 h-4 text-red-500" />
              )}
              <p className={cn(
                "text-xs font-mono uppercase tracking-widest transition-colors",
                isEmergency ? "text-red-500 font-bold animate-pulse" : 
                connected ? "text-emerald-500" : 
                connecting ? "text-yellow-500" : "text-zinc-500"
              )}>
                {isEmergency ? "EMERGENCY DECLARED" : 
                 connected ? "CONNECTED" : 
                 connecting ? "CONNECTING..." : "STANDING BY"}
              </p>
            </div>

            <p className="text-[10px] text-zinc-600">
              {connected ? "Press and hold to transmit" : "Waiting for connection..."}
            </p>
            
            {liveKitParticipants.length > 0 && (
              <p className="text-[10px] text-cyan-500/70">
                {liveKitParticipants.length} unit{liveKitParticipants.length !== 1 ? 's' : ''} on channel
              </p>
            )}
            
            <div className="flex items-center justify-center gap-1">
              <MapPin className={cn(
                "w-3 h-3",
                userLocation ? "text-emerald-500" : "text-zinc-600"
              )} />
              <p className="text-[10px] text-zinc-600">
                {userLocation ? "GPS Active" : "GPS Initializing..."}
              </p>
            </div>
          </div>
        </div>

        <div className="h-48 shrink-0">
          <PresenceList units={unitPresence} isLoading={false} />
        </div>

      </div>
    </MobileFrame>
  );
}
