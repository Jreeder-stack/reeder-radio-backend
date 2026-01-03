import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ChevronUp, ChevronDown, List, Settings, AlertTriangle, MessageSquare, Users, MoreHorizontal, Plus, Mail, GripVertical, Wifi, WifiOff, X, Loader2, Search } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useLiveKitConnection } from '../../context/LiveKitConnectionContext';
import { useSignalingContext } from '../../context/SignalingContext';
import { useMobileRadioContext } from '../../context/MobileRadioContext';
import { micPTTManager } from '../../audio/MicPTTManager';
import { PTT_STATES } from '../../constants/pttStates';
import { updateUnitStatus } from '../../utils/api';
import { DataPacket_Kind } from 'livekit-client';
import { PTTButton } from './PTTButton';
import { 
  AnimalSearchModal, 
  CitationModal, 
  CadMapModal, 
  FieldInterviewModal, 
  FleetModal, 
  WeatherWidget, 
  BoloWidget,
  MessagesWidget,
  NewMessageModal 
} from './widgets';

const STATUS_LABELS = {
  'off_duty': 'OFF DUTY',
  'on_duty': 'ON DUTY',
  'en_route': 'EN ROUTE',
  'arrived': 'ARRIVED',
  'oos': 'OOS',
  'out_of_service': 'OOS',
};

const STATUS_CYCLE = ['off_duty', 'on_duty', 'en_route', 'arrived', 'oos'];

function formatStatus(status) {
  return STATUS_LABELS[status?.toLowerCase()] || status?.toUpperCase()?.replace(/_/g, ' ') || 'UNKNOWN';
}

function getNextStatus(currentStatus) {
  const currentIndex = STATUS_CYCLE.indexOf(currentStatus?.toLowerCase());
  const nextIndex = (currentIndex + 1) % STATUS_CYCLE.length;
  return STATUS_CYCLE[nextIndex];
}

const defaultButtons = [
  { id: 'f1', label: 'Person', sublabel: 'Query' },
  { id: 'f2', label: 'Vehicle', sublabel: 'Query' },
  { id: 'f3', label: 'Custom', sublabel: 'F3' },
  { id: 'f4', label: 'Custom', sublabel: 'F4' },
  { id: 'widget', label: 'Widget', sublabel: '' },
];

const F3F4_WIDGET_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'animal', label: 'Animal Search' },
  { value: 'citation', label: 'Citation/Warning' },
  { value: 'map', label: 'CAD Map' },
  { value: 'fi', label: 'Field Interview' },
  { value: 'fleet', label: 'Fleet' },
];

const MAIN_WIDGET_OPTIONS = [
  { value: 'weather', label: 'Weather' },
  { value: 'bolo', label: 'Recent BOLOs' },
];

export function RadioDeckView({ user, onLogout }) {
  const identity = (user?.unit_id && user.unit_id.trim()) || user?.username || 'Unknown';
  
  const {
    livekitManager,
    connectionStatus,
    switchChannel: contextSwitchChannel,
    ensureConnected,
  } = useLiveKitConnection();
  
  const {
    channelMembers,
    activeTransmissions,
    isTransmitting: isChannelTransmitting,
    getTransmittingUnit,
    joinChannel: signalingJoinChannel,
    leaveChannel: signalingLeaveChannel,
    signalPttStart,
    signalPttEnd,
    connected: signalingConnected,
  } = useSignalingContext();
  
  const { isScanning, toggleScanning, isEmergency, triggerEmergency, cancelEmergency, scanChannels, setScanChannels, toggleScanChannel } = useMobileRadioContext();
  
  const connected = signalingConnected;
  const connecting = connectionStatus === 'connecting';
  
  const [channels, setChannels] = useState([]);
  const [channelsLoading, setChannelsLoading] = useState(true);
  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [currentZoneIndex, setCurrentZoneIndex] = useState(0);
  const [showPTT, setShowPTT] = useState(() => {
    const saved = localStorage.getItem('radio_show_ptt');
    return saved !== 'false';
  });
  const [showScanList, setShowScanList] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [unitStatus, setUnitStatus] = useState('off_duty');
  const [hasActiveCall, setHasActiveCall] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [cadConnected, setCadConnected] = useState(null);
  const [showPersonQuery, setShowPersonQuery] = useState(false);
  const [showVehicleQuery, setShowVehicleQuery] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [showAnimalSearch, setShowAnimalSearch] = useState(false);
  const [showCitation, setShowCitation] = useState(false);
  const [showCadMap, setShowCadMap] = useState(false);
  const [showFI, setShowFI] = useState(false);
  const [showFleet, setShowFleet] = useState(false);
  const [showWeather, setShowWeather] = useState(false);
  const [showBolo, setShowBolo] = useState(false);
  const [showMessages, setShowMessages] = useState(false);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [personQueryForm, setPersonQueryForm] = useState({ firstName: '', lastName: '', dob: '' });
  const [vehicleQueryForm, setVehicleQueryForm] = useState({ plate: '', state: '', vin: '' });
  const [queryResult, setQueryResult] = useState(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState(null);
  const [functionButtons, setFunctionButtons] = useState(() => {
    const saved = localStorage.getItem('radio_function_buttons');
    return saved ? JSON.parse(saved) : defaultButtons;
  });
  const [widgetConfig, setWidgetConfig] = useState(() => {
    const saved = localStorage.getItem('radio_widget_config');
    return saved ? JSON.parse(saved) : { f3: 'none', f4: 'none', widget: 'weather' };
  });
  const [draggedItem, setDraggedItem] = useState(null);
  const [isTransmitting, setIsTransmitting] = useState(false);
  const [pttState, setPttState] = useState(PTT_STATES.IDLE);
  const [activeAudio, setActiveAudio] = useState(null);
  
  const hasJoinedRef = useRef(false);
  const transmitChannelRef = useRef('');
  const isEmergencyRef = useRef(false);
  const rxAudioElementsRef = useRef(new Set());

  useEffect(() => {
    fetch('/api/channels', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        const channelList = Array.isArray(data) ? data : (data?.channels || []);
        if (channelList.length > 0) {
          setChannels(channelList);
          if (scanChannels.length === 0) {
            setScanChannels(channelList.map(ch => ({ id: ch.id, name: ch.name, enabled: true })));
          }
        }
        setChannelsLoading(false);
      })
      .catch(err => {
        console.error('Failed to load channels:', err);
        setChannelsLoading(false);
      });
  }, [scanChannels.length, setScanChannels]);

  const zones = useMemo(() => {
    const zoneSet = new Set();
    channels.forEach(ch => {
      if (ch.zone) zoneSet.add(ch.zone);
    });
    const uniqueZones = Array.from(zoneSet).sort();
    return uniqueZones.length > 0 ? ['ALL', ...uniqueZones] : ['ALL'];
  }, [channels]);
  
  const currentZone = zones[currentZoneIndex] || 'ALL';
  
  const filteredChannels = useMemo(() => {
    if (currentZone === 'ALL') return channels;
    return channels.filter(ch => ch.zone === currentZone);
  }, [channels, currentZone]);
  
  const currentChannel = filteredChannels[currentChannelIndex];
  const currentChannelName = currentChannel?.name || null;

  useEffect(() => {
    transmitChannelRef.current = currentChannelName || '';
  }, [currentChannelName]);
  
  useEffect(() => {
    isEmergencyRef.current = isEmergency;
  }, [isEmergency]);

  useEffect(() => {
    if (currentChannel && !hasJoinedRef.current) {
      hasJoinedRef.current = true;
      contextSwitchChannel(currentChannel.name);
      signalingJoinChannel(currentChannel.name);
    }
  }, [currentChannel, contextSwitchChannel, signalingJoinChannel]);

  useEffect(() => {
    if (channels.length > 0 && scanChannels.length === 0) {
      setScanChannels(channels.map(ch => ({ id: ch.id, name: ch.name, enabled: false })));
    }
  }, [channels, scanChannels.length, setScanChannels]);

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
          updateUnitStatus(identity, txChannel, 'transmitting', null, isEmergencyRef.current).catch(() => {});
        }
      } else if (newState === PTT_STATES.IDLE) {
        setIsTransmitting(false);
        rxAudioElementsRef.current.forEach(el => { el.muted = false; });
        if (txChannel) {
          broadcastStatus('idle', txChannel);
          updateUnitStatus(identity, txChannel, 'idle', null, isEmergencyRef.current).catch(() => {});
        }
      }
    };
    
    return () => {
      micPTTManager.disconnect();
    };
  }, [broadcastStatus, identity]);

  useEffect(() => {
    const fetchInitialStatus = async () => {
      try {
        const response = await fetch('/api/cad/status-check', { credentials: 'include' });
        const data = await response.json();
        
        if (response.ok && data.success && data.units && Array.isArray(data.units)) {
          setCadConnected(true);
          const myUnit = data.units.find(u => u.unit_id === identity);
          if (myUnit?.status) {
            console.log('[Status] Initial status from CAD:', myUnit.status);
            setUnitStatus(myUnit.status);
          }
        } else {
          console.log('[Status] CAD not connected');
          setCadConnected(false);
        }
      } catch (err) {
        console.error('[Status] Failed to fetch initial status:', err);
        setCadConnected(false);
      }
    };
    
    if (identity) {
      fetchInitialStatus();
    }
  }, [identity]);

  useEffect(() => {
    const fetchUnreadCount = async () => {
      try {
        const response = await fetch('/api/cad/messages/unread', { credentials: 'include' });
        const data = await response.json();
        if (response.ok && typeof data.count === 'number') {
          setUnreadCount(data.count);
        }
      } catch (err) {
        console.error('[Messages] Failed to fetch unread count:', err);
      }
    };

    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleCycleStatus = async () => {
    if (statusLoading) return;
    setStatusLoading(true);
    
    const nextStatus = getNextStatus(unitStatus);
    
    try {
      const response = await fetch(`/api/cad/unit/${encodeURIComponent(identity)}/status/cycle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
      });
      
      const data = await response.json();
      
      if (response.ok && data.success !== false) {
        const newStatus = data.newStatus || data.status;
        if (newStatus) {
          setUnitStatus(newStatus);
          setHasActiveCall(data.hasActiveCall || false);
          console.log('[Status] Cycled to:', newStatus, 'hasActiveCall:', data.hasActiveCall);
          if (currentChannelName) {
            broadcastStatus(newStatus, currentChannelName);
          }
        } else {
          setUnitStatus(nextStatus);
          if (currentChannelName) {
            broadcastStatus(nextStatus, currentChannelName);
          }
        }
      } else {
        console.log('[Status] CAD unavailable, using local cycle:', nextStatus);
        setUnitStatus(nextStatus);
        if (currentChannelName) {
          broadcastStatus(nextStatus, currentChannelName);
        }
      }
    } catch (err) {
      console.error('Failed to cycle status, using local fallback:', err);
      setUnitStatus(nextStatus);
      if (currentChannelName) {
        broadcastStatus(nextStatus, currentChannelName);
      }
    } finally {
      setStatusLoading(false);
    }
  };
  
  const handleZoneUp = () => {
    const oldChannel = filteredChannels[currentChannelIndex];
    if (oldChannel) {
      signalingLeaveChannel(oldChannel.name);
    }
    
    setCurrentZoneIndex(prev => (prev + 1) % zones.length);
    setCurrentChannelIndex(0);
    hasJoinedRef.current = false;
  };
  
  const handleZoneDown = () => {
    const oldChannel = filteredChannels[currentChannelIndex];
    if (oldChannel) {
      signalingLeaveChannel(oldChannel.name);
    }
    
    setCurrentZoneIndex(prev => prev === 0 ? zones.length - 1 : prev - 1);
    setCurrentChannelIndex(0);
    hasJoinedRef.current = false;
  };

  useEffect(() => {
    if (hasJoinedRef.current === false && filteredChannels.length > 0 && currentChannelIndex < filteredChannels.length) {
      const channel = filteredChannels[currentChannelIndex];
      if (channel) {
        hasJoinedRef.current = true;
        contextSwitchChannel(channel.name);
        signalingJoinChannel(channel.name);
      }
    }
  }, [currentZoneIndex, filteredChannels, currentChannelIndex, contextSwitchChannel, signalingJoinChannel]);

  const handleChannelUp = () => {
    if (filteredChannels.length === 0) return;
    const oldChannel = filteredChannels[currentChannelIndex];
    if (oldChannel) {
      signalingLeaveChannel(oldChannel.name);
    }
    
    const newIndex = (currentChannelIndex + 1) % filteredChannels.length;
    setCurrentChannelIndex(newIndex);
    const channel = filteredChannels[newIndex];
    if (channel) {
      contextSwitchChannel(channel.name);
      signalingJoinChannel(channel.name);
    }
  };

  const handleChannelDown = () => {
    if (filteredChannels.length === 0) return;
    const oldChannel = filteredChannels[currentChannelIndex];
    if (oldChannel) {
      signalingLeaveChannel(oldChannel.name);
    }
    
    const newIndex = currentChannelIndex === 0 ? filteredChannels.length - 1 : currentChannelIndex - 1;
    setCurrentChannelIndex(newIndex);
    const channel = filteredChannels[newIndex];
    if (channel) {
      contextSwitchChannel(channel.name);
      signalingJoinChannel(channel.name);
    }
  };

  const handleEmergencyToggle = async () => {
    const channel = currentChannelName || 'DISPATCH';
    
    if (isEmergency) {
      await cancelEmergency();
      try {
        await fetch('/api/dispatch/emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ channel, active: false }),
        });
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher of cancellation:', err);
      }
    } else {
      await triggerEmergency();
      try {
        await fetch('/api/dispatch/emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ channel, active: true }),
        });
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher:', err);
      }
    }
  };

  const handleTransmitStart = useCallback(async () => {
    const channelName = transmitChannelRef.current;
    if (!channelName) return;
    
    await ensureConnected();
    const room = livekitManager?.getRoom(channelName);
    if (!room) return;
    
    signalPttStart(channelName);
    micPTTManager.start(room);
  }, [ensureConnected, livekitManager, signalPttStart]);

  const handleTransmitEnd = useCallback(() => {
    const channelName = transmitChannelRef.current;
    if (!isEmergencyRef.current && micPTTManager.canStop()) {
      micPTTManager.stop();
      if (channelName) {
        signalPttEnd(channelName);
      }
    }
  }, [signalPttEnd]);

  const handleDragStart = (id) => {
    setDraggedItem(id);
  };

  const handleDragOver = (e, targetId) => {
    e.preventDefault();
    if (!draggedItem || draggedItem === targetId) return;
    
    const newButtons = [...functionButtons];
    const draggedIndex = newButtons.findIndex(b => b.id === draggedItem);
    const targetIndex = newButtons.findIndex(b => b.id === targetId);
    
    if (draggedIndex !== -1 && targetIndex !== -1) {
      const [removed] = newButtons.splice(draggedIndex, 1);
      newButtons.splice(targetIndex, 0, removed);
      setFunctionButtons(newButtons);
      localStorage.setItem('radio_function_buttons', JSON.stringify(newButtons));
    }
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
  };

  const handlePersonQuery = async () => {
    if (!personQueryForm.firstName && !personQueryForm.lastName && !personQueryForm.dob) {
      setQueryError('Please enter at least one search field');
      return;
    }
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const response = await fetch('/api/cad/query/person', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(personQueryForm),
      });
      const data = await response.json();
      if (response.ok) {
        setQueryResult(data);
      } else {
        setQueryError(data.message || 'Query failed');
      }
    } catch (err) {
      setQueryError('Failed to connect to CAD');
    } finally {
      setQueryLoading(false);
    }
  };

  const handleVehicleQuery = async () => {
    if (!vehicleQueryForm.plate && !vehicleQueryForm.vin) {
      setQueryError('Please enter plate or VIN');
      return;
    }
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const response = await fetch('/api/cad/query/vehicle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(vehicleQueryForm),
      });
      const data = await response.json();
      if (response.ok) {
        setQueryResult(data);
      } else {
        setQueryError(data.message || 'Query failed');
      }
    } catch (err) {
      setQueryError('Failed to connect to CAD');
    } finally {
      setQueryLoading(false);
    }
  };

  const fetchContacts = async () => {
    setContactsLoading(true);
    try {
      const response = await fetch('/api/unit/contacts', { credentials: 'include' });
      const data = await response.json();
      if (Array.isArray(data)) {
        setContacts(data);
      } else if (data.contacts) {
        setContacts(data.contacts);
      }
    } catch (err) {
      console.error('Failed to fetch contacts:', err);
    } finally {
      setContactsLoading(false);
    }
  };

  const handleOpenContacts = () => {
    setShowContacts(true);
    fetchContacts();
  };

  const openWidgetByType = (widgetType) => {
    switch (widgetType) {
      case 'animal':
        setShowAnimalSearch(true);
        break;
      case 'citation':
        setShowCitation(true);
        break;
      case 'map':
        setShowCadMap(true);
        break;
      case 'fi':
        setShowFI(true);
        break;
      case 'fleet':
        setShowFleet(true);
        break;
      case 'weather':
        setShowWeather(true);
        break;
      case 'bolo':
        setShowBolo(true);
        break;
      default:
        break;
    }
  };

  const handleFunctionButtonClick = (btnId) => {
    if (btnId === 'f1') {
      setQueryResult(null);
      setQueryError(null);
      setShowPersonQuery(true);
    } else if (btnId === 'f2') {
      setQueryResult(null);
      setQueryError(null);
      setShowVehicleQuery(true);
    } else if (btnId === 'f3') {
      openWidgetByType(widgetConfig.f3);
    } else if (btnId === 'f4') {
      openWidgetByType(widgetConfig.f4);
    } else if (btnId === 'widget') {
      openWidgetByType(widgetConfig.widget);
    }
  };

  const togglePTTVisibility = () => {
    const newValue = !showPTT;
    setShowPTT(newValue);
    localStorage.setItem('radio_show_ptt', String(newValue));
  };

  const handleWidgetConfigChange = (key, value) => {
    const newConfig = { ...widgetConfig, [key]: value };
    setWidgetConfig(newConfig);
    localStorage.setItem('radio_widget_config', JSON.stringify(newConfig));
  };

  const getButtonDisplay = (btnId) => {
    if (btnId === 'f1') return { label: 'Person', sublabel: 'Query' };
    if (btnId === 'f2') return { label: 'Vehicle', sublabel: 'Query' };
    if (btnId === 'f3') {
      const opt = F3F4_WIDGET_OPTIONS.find(o => o.value === widgetConfig.f3);
      return { label: opt?.label || 'F3', sublabel: 'F3' };
    }
    if (btnId === 'f4') {
      const opt = F3F4_WIDGET_OPTIONS.find(o => o.value === widgetConfig.f4);
      return { label: opt?.label || 'F4', sublabel: 'F4' };
    }
    if (btnId === 'widget') {
      const opt = MAIN_WIDGET_OPTIONS.find(o => o.value === widgetConfig.widget);
      return { label: opt?.label || 'Widget', sublabel: '' };
    }
    return { label: btnId, sublabel: '' };
  };

  const isReceiving = !!activeAudio;
  const transmittingUnitId = useMemo(() => {
    if (!currentChannelName) return null;
    return getTransmittingUnit(currentChannelName);
  }, [currentChannelName, getTransmittingUnit, activeTransmissions]);

  return (
    <div 
      className="min-h-screen w-full bg-gray-100 flex flex-col p-2 space-y-2 font-body"
      style={{
        paddingTop: 'max(env(safe-area-inset-top, 0px), 8px)',
        paddingBottom: 'max(env(safe-area-inset-bottom, 0px), 16px)',
      }}
    >
      
      <div 
        className={cn(
          "bg-white rounded-lg p-3 shadow-sm border border-gray-200 cursor-pointer active:bg-gray-50 transition-all",
          statusLoading && "opacity-60",
          cadConnected === false && "border-red-300 bg-red-50"
        )}
        onClick={cadConnected === false ? undefined : handleCycleStatus}
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500 font-medium mb-1">
              My Status {hasActiveCall && <span className="text-orange-600">(CALL ACTIVE)</span>}
            </div>
            <div className={cn("text-xl font-bold", cadConnected === false ? "text-red-600" : "text-black")}>
              {statusLoading ? "..." : cadConnected === false ? "CAD DISCONNECTED" : formatStatus(unitStatus)}
            </div>
          </div>
          <div className="text-xs text-gray-400">{cadConnected === false ? "No CAD connection" : "Tap to cycle"}</div>
        </div>
      </div>

      <div className="bg-white rounded-lg p-3 shadow-sm border border-gray-200">
        <div className="flex items-stretch gap-2">
          <div className="flex-1 flex flex-col">
            <div className="text-xs text-gray-500 font-medium">{currentZone}</div>
            <div className="text-2xl font-bold text-black">
              {channelsLoading ? "LOADING..." : currentChannel?.name || "NO CHANNEL"}
            </div>
            
            {isReceiving && transmittingUnitId && (
              <div className="mt-1 text-lg font-medium text-cyan-600 animate-pulse">
                RX: {transmittingUnitId}
              </div>
            )}
            
            <div className="flex items-center gap-2 text-xs mt-auto">
              {isScanning && <span className="text-green-600 font-bold">SCAN</span>}
              {isEmergency && <span className="text-red-600 font-bold animate-pulse">EMERG</span>}
              {cadConnected ? (
                <span className="text-green-600 flex items-center gap-0.5">
                  <Wifi className="w-3 h-3" />CAD
                </span>
              ) : (
                <span className="text-red-500 flex items-center gap-0.5">
                  <WifiOff className="w-3 h-3" />CAD
                </span>
              )}
            </div>
          </div>

          <button
            onClick={toggleScanning}
            className={cn(
              "w-8 h-8 rounded border flex items-center justify-center active:scale-95 transition-all self-center",
              isScanning 
                ? "bg-green-500 border-green-600" 
                : "bg-gray-100 border-gray-300"
            )}
          >
            <svg 
              viewBox="0 0 24 24" 
              className={cn("w-6 h-6", isScanning ? "text-white" : "text-gray-700")}
              fill="none" 
              stroke="currentColor" 
              strokeWidth="2"
              strokeLinecap="round" 
              strokeLinejoin="round"
            >
              <path d="M6 3 L3 6 L6 9" />
              <path d="M7 6 H17 L7 18 H17" />
              <path d="M18 15 L21 18 L18 21" />
            </svg>
          </button>

          <div className="flex flex-col items-center gap-1">
            <button
              onClick={handleZoneUp}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
            >
              <ChevronUp className="w-6 h-6 text-black" />
            </button>
            <div className="text-xs text-gray-500 font-mono">ZN</div>
            <button
              onClick={handleZoneDown}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
            >
              <ChevronDown className="w-6 h-6 text-black" />
            </button>
          </div>

          <div className="flex flex-col items-center gap-1">
            <button
              onClick={handleChannelUp}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
            >
              <ChevronUp className="w-6 h-6 text-black" />
            </button>
            <div className="text-xs text-gray-500 font-mono">CH</div>
            <button
              onClick={handleChannelDown}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
            >
              <ChevronDown className="w-6 h-6 text-black" />
            </button>
          </div>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setShowScanList(true)}
          className={cn(
            "flex-1 bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex flex-col items-center gap-1 active:bg-gray-50 transition-all",
            isScanning && "bg-green-50 border-green-300"
          )}
        >
          <List className="w-6 h-6 text-cyan-600" />
          <span className="text-xs text-gray-600 font-medium">Scan Lists</span>
        </button>
        
        <button
          onClick={handleOpenContacts}
          className="flex-1 bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex flex-col items-center gap-1 active:bg-gray-50 transition-all"
        >
          <Users className="w-6 h-6 text-cyan-600" />
          <span className="text-xs text-gray-600 font-medium">Contacts</span>
        </button>
        
        <button
          onClick={() => setShowSettings(true)}
          className="flex-1 bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex flex-col items-center gap-1 active:bg-gray-50 transition-all"
        >
          <MoreHorizontal className="w-6 h-6 text-cyan-600" />
          <span className="text-xs text-gray-600 font-medium">More</span>
        </button>
      </div>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-3 py-2 flex items-center gap-3">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <MessageSquare className="w-5 h-5 text-cyan-600 flex-shrink-0" />
            <span className="font-bold text-black text-sm truncate">Messages</span>
            {unreadCount > 0 && (
              <span className="bg-red-500 text-white text-xs px-1.5 py-0.5 rounded-full font-bold flex-shrink-0">
                {unreadCount}
              </span>
            )}
            <span className="text-xs text-gray-500 truncate">
              {unreadCount > 0 ? `${unreadCount} unread` : 'No new'}
            </span>
          </div>
          <div className="flex gap-1.5 flex-shrink-0">
            <button
              onClick={() => setShowMessages(true)}
              className="px-3 py-1.5 bg-cyan-600 text-white text-xs font-medium rounded active:bg-cyan-700"
            >
              View
            </button>
            <button
              onClick={() => setShowNewMessage(true)}
              className="px-3 py-1.5 bg-gray-200 text-gray-700 text-xs font-medium rounded active:bg-gray-300"
            >
              New
            </button>
          </div>
        </div>
      </div>

      <button
        onClick={handleEmergencyToggle}
        className={cn(
          "w-full rounded-lg p-3 flex items-center justify-center gap-2 font-bold text-sm uppercase tracking-wider transition-all active:scale-98",
          isEmergency 
            ? "bg-red-600 text-white animate-pulse" 
            : "bg-white border border-gray-200 text-red-600 shadow-sm"
        )}
      >
        <AlertTriangle className="w-5 h-5" />
        {isEmergency ? "EMERGENCY ACTIVE" : "EMERGENCY"}
      </button>

      {showPTT && (
        <PTTButton
          onTransmitStart={handleTransmitStart}
          onTransmitEnd={handleTransmitEnd}
          isConnected={signalingConnected}
          isTransmitting={isTransmitting}
          isReceiving={isReceiving}
          activeSpeaker={transmittingUnitId}
          setTransmitting={setIsTransmitting}
        />
      )}

      <div className="grid grid-cols-2 gap-2 flex-1 auto-rows-[4rem]">
        {functionButtons.map((btn) => {
          const display = getButtonDisplay(btn.id);
          return (
            <div
              key={btn.id}
              draggable
              onDragStart={() => handleDragStart(btn.id)}
              onDragOver={(e) => handleDragOver(e, btn.id)}
              onDragEnd={handleDragEnd}
              onClick={() => handleFunctionButtonClick(btn.id)}
              className={cn(
                "bg-white rounded-xl border border-gray-200 flex items-center justify-center text-gray-700 shadow-sm active:bg-gray-50 transition-all cursor-pointer relative",
                btn.id === 'widget' ? "col-span-2 row-span-2 flex-1" : "h-16",
                draggedItem === btn.id && "opacity-50 scale-95"
              )}
            >
              <GripVertical className="w-4 h-4 text-gray-300 absolute left-2" />
              <div className="flex flex-col items-center">
                <span className="font-bold text-sm">{display.label}</span>
                {display.sublabel && <span className="text-xs text-gray-500">{display.sublabel}</span>}
              </div>
            </div>
          );
        })}
      </div>

      {showScanList && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm max-h-[70vh] flex flex-col">
            <div className="p-4 border-b border-black flex items-center justify-between">
              <h2 className="text-black font-mono font-bold uppercase tracking-wider">Scan List</h2>
              <button
                onClick={toggleScanning}
                className={cn(
                  "px-4 py-2 rounded font-mono text-xs uppercase border border-black",
                  isScanning ? "bg-green-300 text-black font-bold" : "bg-gray-200 text-black"
                )}
              >
                {isScanning ? 'SCANNING' : 'OFF'}
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 space-y-2">
              {scanChannels.map((ch) => (
                <label key={ch.id} className="flex items-center gap-3 p-2 border border-gray-200 rounded">
                  <input
                    type="checkbox"
                    checked={ch.enabled}
                    onChange={() => toggleScanChannel(ch.id)}
                    className="w-5 h-5"
                  />
                  <span className="font-mono text-black">{ch.name}</span>
                </label>
              ))}
            </div>
            <div className="p-4 border-t border-black">
              <button
                onClick={() => setShowScanList(false)}
                className="w-full py-2 bg-black text-white font-mono uppercase rounded"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col">
            <div className="p-4 border-b border-black">
              <h2 className="text-black font-mono font-bold uppercase tracking-wider">Settings</h2>
            </div>
            <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">
              <label className="flex items-center justify-between">
                <span className="text-black font-medium">Show PTT Button</span>
                <input
                  type="checkbox"
                  checked={showPTT}
                  onChange={togglePTTVisibility}
                  className="w-5 h-5"
                />
              </label>
              
              <div className="pt-4 border-t border-gray-200 space-y-3">
                <h3 className="text-sm font-bold text-gray-700 uppercase">Widget Configuration</h3>
                
                <div className="flex items-center justify-between">
                  <span className="text-black font-medium text-sm">F3 Button</span>
                  <select
                    value={widgetConfig.f3}
                    onChange={(e) => handleWidgetConfigChange('f3', e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 text-sm text-black bg-white"
                  >
                    {F3F4_WIDGET_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-black font-medium text-sm">F4 Button</span>
                  <select
                    value={widgetConfig.f4}
                    onChange={(e) => handleWidgetConfigChange('f4', e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 text-sm text-black bg-white"
                  >
                    {F3F4_WIDGET_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
                
                <div className="flex items-center justify-between">
                  <span className="text-black font-medium text-sm">Large Widget</span>
                  <select
                    value={widgetConfig.widget}
                    onChange={(e) => handleWidgetConfigChange('widget', e.target.value)}
                    className="border border-gray-300 rounded px-2 py-1 text-sm text-black bg-white"
                  >
                    {MAIN_WIDGET_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              
              <div className="pt-4 border-t border-gray-200">
                <button
                  onClick={() => {
                    setShowSettings(false);
                    if (onLogout) onLogout();
                  }}
                  className="w-full py-2 bg-red-600 text-white font-mono uppercase rounded font-bold"
                >
                  Log Out
                </button>
              </div>
            </div>
            <div className="p-4 border-t border-black">
              <button
                onClick={() => setShowSettings(false)}
                className="w-full py-2 bg-black text-white font-mono uppercase rounded"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {showContacts && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm max-h-[70vh] flex flex-col">
            <div className="p-4 border-b border-black flex items-center justify-between">
              <h2 className="text-black font-mono font-bold uppercase tracking-wider">Contacts</h2>
              <button onClick={() => setShowContacts(false)} className="text-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {contactsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                </div>
              ) : contacts.length === 0 ? (
                <p className="text-center text-gray-500 py-8">No contacts found</p>
              ) : (
                <div className="space-y-2">
                  {contacts.map((contact, i) => (
                    <div key={i} className="p-3 border border-gray-200 rounded">
                      <p className="font-bold text-black">{contact.name || contact.unit_id}</p>
                      {contact.role && <p className="text-xs text-gray-500">{contact.role}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showPersonQuery && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col">
            <div className="p-4 border-b border-black flex items-center justify-between">
              <h2 className="text-black font-mono font-bold uppercase tracking-wider">Person Query</h2>
              <button onClick={() => setShowPersonQuery(false)} className="text-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <input
                type="text"
                placeholder="First Name"
                value={personQueryForm.firstName}
                onChange={(e) => setPersonQueryForm(p => ({ ...p, firstName: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <input
                type="text"
                placeholder="Last Name"
                value={personQueryForm.lastName}
                onChange={(e) => setPersonQueryForm(p => ({ ...p, lastName: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <input
                type="text"
                placeholder="DOB (MM/DD/YYYY)"
                value={personQueryForm.dob}
                onChange={(e) => setPersonQueryForm(p => ({ ...p, dob: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              {queryError && <p className="text-red-600 text-sm">{queryError}</p>}
              {queryResult && (
                <div className="p-3 bg-gray-100 rounded text-sm text-black">
                  <pre className="whitespace-pre-wrap">{JSON.stringify(queryResult, null, 2)}</pre>
                </div>
              )}
              <button
                onClick={handlePersonQuery}
                disabled={queryLoading}
                className="w-full py-2 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                {queryLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Search
              </button>
            </div>
          </div>
        </div>
      )}

      {showVehicleQuery && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col">
            <div className="p-4 border-b border-black flex items-center justify-between">
              <h2 className="text-black font-mono font-bold uppercase tracking-wider">Vehicle Query</h2>
              <button onClick={() => setShowVehicleQuery(false)} className="text-black">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <input
                type="text"
                placeholder="Plate Number"
                value={vehicleQueryForm.plate}
                onChange={(e) => setVehicleQueryForm(p => ({ ...p, plate: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <input
                type="text"
                placeholder="State (e.g., IN)"
                value={vehicleQueryForm.state}
                onChange={(e) => setVehicleQueryForm(p => ({ ...p, state: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <input
                type="text"
                placeholder="VIN (optional)"
                value={vehicleQueryForm.vin}
                onChange={(e) => setVehicleQueryForm(p => ({ ...p, vin: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              {queryError && <p className="text-red-600 text-sm">{queryError}</p>}
              {queryResult && (
                <div className="p-3 bg-gray-100 rounded text-sm text-black">
                  <pre className="whitespace-pre-wrap">{JSON.stringify(queryResult, null, 2)}</pre>
                </div>
              )}
              <button
                onClick={handleVehicleQuery}
                disabled={queryLoading}
                className="w-full py-2 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                {queryLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Search
              </button>
            </div>
          </div>
        </div>
      )}

      <AnimalSearchModal show={showAnimalSearch} onClose={() => setShowAnimalSearch(false)} />
      <CitationModal show={showCitation} onClose={() => setShowCitation(false)} />
      <CadMapModal show={showCadMap} onClose={() => setShowCadMap(false)} />
      <FieldInterviewModal show={showFI} onClose={() => setShowFI(false)} />
      <FleetModal show={showFleet} onClose={() => setShowFleet(false)} identity={identity} />
      <WeatherWidget show={showWeather} onClose={() => setShowWeather(false)} />
      <BoloWidget show={showBolo} onClose={() => setShowBolo(false)} />
      <MessagesWidget show={showMessages} onClose={() => setShowMessages(false)} />
      <NewMessageModal show={showNewMessage} onClose={() => setShowNewMessage(false)} />
    </div>
  );
}
