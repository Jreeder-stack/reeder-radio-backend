import React, { useState, useEffect, useRef, useCallback } from "react";
import { ChevronUp, ChevronDown, List, Settings, AlertTriangle, MessageSquare, Users, MoreHorizontal, Plus, Mail, GripVertical, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRadio } from "@/lib/radio-context";
import { useChannels } from "@/hooks/use-channels";
import { useLiveKit } from "@/hooks/use-livekit";
import { useLocation } from "@/hooks/use-location";
import { useCadWebSocket, type UnitStatusChange } from "@/hooks/use-cad-websocket";
import { apiClient, type Contact } from "@/lib/api-client";

type FunctionButton = {
  id: string;
  label: string;
  sublabel: string;
};

const STATUS_LABELS: Record<string, string> = {
  'off_duty': 'OFF DUTY',
  'on_duty': 'ON DUTY',
  'en_route': 'EN ROUTE',
  'arrived': 'ARRIVED',
  'oos': 'OOS',
  'out_of_service': 'OOS',
};

function formatStatus(status: string): string {
  return STATUS_LABELS[status.toLowerCase()] || status.toUpperCase().replace(/_/g, ' ');
}

const defaultButtons: FunctionButton[] = [
  { id: 'f1', label: 'Person', sublabel: 'Query' },
  { id: 'f2', label: 'Vehicle', sublabel: 'Query' },
  { id: 'f3', label: 'Custom', sublabel: 'F3' },
  { id: 'f4', label: 'Custom', sublabel: 'F4' },
  { id: 'widget', label: 'Widget', sublabel: '' },
];

export default function CommsRadioPage() {
  const { isScanning, toggleScanning, isEmergency, triggerEmergency, cancelEmergency, scanChannels, setScanChannels, toggleScanChannel } = useRadio();
  const { data: channels = [], isLoading: channelsLoading } = useChannels();
  const [currentChannelIndex, setCurrentChannelIndex] = useState(0);
  const [showPTT, setShowPTT] = useState(() => {
    const saved = localStorage.getItem('radio_show_ptt');
    return saved !== 'false';
  });
  const [showScanList, setShowScanList] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [unitStatus, setUnitStatus] = useState<string>('Loading...');
  const [hasActiveCall, setHasActiveCall] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [showPersonQuery, setShowPersonQuery] = useState(false);
  const [showVehicleQuery, setShowVehicleQuery] = useState(false);
  const [showContacts, setShowContacts] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [personQueryForm, setPersonQueryForm] = useState({ firstName: '', lastName: '', dob: '' });
  const [vehicleQueryForm, setVehicleQueryForm] = useState({ plate: '', state: '', vin: '' });
  const [queryResult, setQueryResult] = useState<any>(null);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [currentZoneIndex, setCurrentZoneIndex] = useState(0);
  const [functionButtons, setFunctionButtons] = useState<FunctionButton[]>(() => {
    const saved = localStorage.getItem('radio_function_buttons');
    return saved ? JSON.parse(saved) : defaultButtons;
  });
  const [draggedItem, setDraggedItem] = useState<string | null>(null);
  const hasJoinedRef = useRef(false);
  
  const myUnitNumber = apiClient.getUnitId();

  const handleStatusChange = useCallback((change: UnitStatusChange) => {
    console.log('[CAD-WS] Status change received:', change);
    setUnitStatus(change.status);
  }, []);

  const handleCycleStatus = async () => {
    if (statusLoading) return;
    setStatusLoading(true);
    try {
      const response = await apiClient.cycleStatus();
      if (response.success && response.data) {
        setUnitStatus(response.data.newStatus);
        setHasActiveCall(response.data.hasActiveCall);
        console.log('[Status] Cycled from', response.data.previousStatus, 'to', response.data.newStatus);
      } else {
        console.error('[Status] Cycle failed:', response.error);
      }
    } catch (err) {
      console.error('[Status] Cycle error:', err);
    } finally {
      setStatusLoading(false);
    }
  };

  const { isConnected: cadConnected } = useCadWebSocket({
    onStatusChange: handleStatusChange,
    unitNumber: myUnitNumber || undefined,
  });

  // Fetch initial status from CAD on mount
  useEffect(() => {
    const fetchInitialStatus = async () => {
      try {
        const result = await apiClient.getMyStatus();
        if (result.status) {
          console.log('[Status] Initial status from CAD:', result.status);
          setUnitStatus(result.status);
        } else {
          console.log('[Status] Unit not found in CAD status check');
          setUnitStatus('Unknown');
        }
      } catch (err) {
        console.error('[Status] Failed to fetch initial status:', err);
        setUnitStatus('Error');
      }
    };
    
    if (myUnitNumber) {
      fetchInitialStatus();
    }
  }, [myUnitNumber]);

  const handleDragStart = (id: string) => {
    setDraggedItem(id);
  };

  const handleDragOver = (e: React.DragEvent, targetId: string) => {
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
      const response = await apiClient.queryPerson(personQueryForm);
      if (response.success) {
        setQueryResult(response.data);
      } else {
        setQueryError(response.error || 'Query failed');
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
      const response = await apiClient.getContacts();
      console.log('[Contacts] API response:', response);
      if (response.success && response.data?.contacts) {
        setContacts(response.data.contacts);
      } else if (response.success && Array.isArray(response.data)) {
        // Handle if contacts come as direct array
        setContacts(response.data as Contact[]);
      } else {
        console.error('[Contacts] Unexpected response structure:', response);
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

  const handleVehicleQuery = async () => {
    if (!vehicleQueryForm.plate && !vehicleQueryForm.vin) {
      setQueryError('Please enter plate or VIN');
      return;
    }
    setQueryLoading(true);
    setQueryError(null);
    setQueryResult(null);
    try {
      const response = await apiClient.queryVehicle(vehicleQueryForm);
      if (response.success) {
        setQueryResult(response.data);
      } else {
        setQueryError(response.error || 'Query failed');
      }
    } catch (err) {
      setQueryError('Failed to connect to CAD');
    } finally {
      setQueryLoading(false);
    }
  };

  const handleFunctionButtonClick = (btnId: string) => {
    if (btnId === 'f1') {
      setQueryResult(null);
      setQueryError(null);
      setShowPersonQuery(true);
    } else if (btnId === 'f2') {
      setQueryResult(null);
      setQueryError(null);
      setShowVehicleQuery(true);
    }
  };

  const updateButtonLabel = (id: string, label: string, sublabel: string) => {
    const newButtons = functionButtons.map(b => 
      b.id === id ? { ...b, label, sublabel } : b
    );
    setFunctionButtons(newButtons);
    localStorage.setItem('radio_function_buttons', JSON.stringify(newButtons));
  };
  
  // Extract unique zones from channels, default to 'ALL' if no zones defined
  const zones = React.useMemo(() => {
    const zoneSet = new Set<string>();
    channels.forEach(ch => {
      if (ch.zone) zoneSet.add(ch.zone);
    });
    const uniqueZones = Array.from(zoneSet).sort();
    return uniqueZones.length > 0 ? ['ALL', ...uniqueZones] : ['ALL'];
  }, [channels]);
  
  const currentZone = zones[currentZoneIndex] || 'ALL';
  
  // Filter channels by current zone
  const filteredChannels = React.useMemo(() => {
    if (currentZone === 'ALL') return channels;
    return channels.filter(ch => ch.zone === currentZone);
  }, [channels, currentZone]);
  
  const handleZoneUp = () => {
    setCurrentZoneIndex(prev => (prev + 1) % zones.length);
    setCurrentChannelIndex(0); // Reset channel index when zone changes
    hasJoinedRef.current = false; // Reset join flag to notify backend of new channel
  };
  
  const handleZoneDown = () => {
    setCurrentZoneIndex(prev => prev === 0 ? zones.length - 1 : prev - 1);
    setCurrentChannelIndex(0); // Reset channel index when zone changes
    hasJoinedRef.current = false; // Reset join flag to notify backend of new channel
  };
  
  const currentChannel = filteredChannels[currentChannelIndex];
  const currentChannelName = currentChannel?.name || null;
  const unitId = apiClient.getUnitId();
  
  const { 
    latitude, 
    longitude, 
    isTracking: isLocationTracking 
  } = useLocation({ 
    autoStart: true 
  });
  
  const { 
    isConnected: liveKitConnected, 
    isConnecting: liveKitConnecting,
    isReceiving,
    activeSpeaker,
    startTransmitting,
    stopTransmitting,
  } = useLiveKit({ 
    channelName: currentChannelName,
    identity: unitId,
    enabled: !!currentChannel 
  });

  useEffect(() => {
    if (filteredChannels?.length && currentChannelIndex >= filteredChannels.length) {
      setCurrentChannelIndex(0);
    }
  }, [filteredChannels, currentChannelIndex]);

  useEffect(() => {
    if (channels.length > 0 && scanChannels.length === 0) {
      setScanChannels(channels.map(ch => ({ id: ch.id, name: ch.name, enabled: false })));
    }
  }, [channels, scanChannels.length, setScanChannels]);

  useEffect(() => {
    if (currentChannel && !hasJoinedRef.current) {
      hasJoinedRef.current = true;
      apiClient.joinChannel(currentChannel.id, currentChannel.name).catch(console.error);
    }
  }, [currentChannel]);

  const handleChannelUp = () => {
    if (filteredChannels.length === 0) return;
    const newIndex = (currentChannelIndex + 1) % filteredChannels.length;
    setCurrentChannelIndex(newIndex);
    const channel = filteredChannels[newIndex];
    if (channel) {
      apiClient.joinChannel(channel.id, channel.name).catch(console.error);
    }
  };

  const handleChannelDown = () => {
    if (filteredChannels.length === 0) return;
    const newIndex = currentChannelIndex === 0 ? filteredChannels.length - 1 : currentChannelIndex - 1;
    setCurrentChannelIndex(newIndex);
    const channel = filteredChannels[newIndex];
    if (channel) {
      apiClient.joinChannel(channel.id, channel.name).catch(console.error);
    }
  };

  const handleEmergencyToggle = async () => {
    const channel = currentChannelName || 'DISPATCH';
    
    if (isEmergency) {
      await cancelEmergency();
      try {
        await apiClient.notifyEmergency(channel, false);
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher of cancellation:', err);
      }
    } else {
      await triggerEmergency();
      try {
        await apiClient.notifyEmergency(channel, true);
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher:', err);
      }
    }
  };

  const togglePTTVisibility = () => {
    const newValue = !showPTT;
    setShowPTT(newValue);
    localStorage.setItem('radio_show_ptt', String(newValue));
  };

  return (
    <div className="min-h-screen w-full bg-gray-100 flex flex-col p-2 space-y-2">
      
      {/* My Status Widget - Tap to cycle */}
      <div 
        className={cn(
          "bg-white rounded-lg p-3 shadow-sm border border-gray-200 cursor-pointer active:bg-gray-50 transition-all",
          statusLoading && "opacity-60"
        )}
        onClick={handleCycleStatus}
        data-testid="widget-status"
      >
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-500 font-medium mb-1">
              My Status {hasActiveCall && <span className="text-orange-600">(CALL ACTIVE)</span>}
            </div>
            <div className="text-xl font-bold text-black">
              {statusLoading ? "..." : formatStatus(unitStatus)}
            </div>
          </div>
          <div className="text-xs text-gray-400">Tap to cycle</div>
        </div>
      </div>

      {/* Zone/Channel Widget */}
      <div className="bg-white rounded-lg p-3 shadow-sm border border-gray-200">
        <div className="flex items-stretch gap-2">
          {/* Zone/Channel Info */}
          <div className="flex-1 flex flex-col">
            <div className="text-xs text-gray-500 font-medium">{currentZone}</div>
            <div className="text-2xl font-bold text-black" data-testid="text-channel-name">
              {channelsLoading ? "LOADING..." : currentChannel?.name || "NO CHANNEL"}
            </div>
            
            {/* Active Speaker Display */}
            {isReceiving && activeSpeaker && (
              <div className="mt-1 text-lg font-medium text-cyan-600 animate-pulse" data-testid="text-active-speaker">
                RX: {activeSpeaker}
              </div>
            )}
            
            {/* Status Indicators - At bottom of box */}
            <div className="flex items-center gap-2 text-xs mt-auto">
              {isScanning && <span className="text-green-600 font-bold">SCAN</span>}
              {isEmergency && <span className="text-red-600 font-bold animate-pulse">EMERG</span>}
              {isLocationTracking && latitude && <span className="text-blue-600">GPS</span>}
              {cadConnected ? (
                <span className="text-green-600 flex items-center gap-0.5" data-testid="indicator-cad-connected">
                  <Wifi className="w-3 h-3" />CAD
                </span>
              ) : (
                <span className="text-gray-400 flex items-center gap-0.5" data-testid="indicator-cad-disconnected">
                  <WifiOff className="w-3 h-3" />CAD
                </span>
              )}
            </div>
          </div>

          {/* Zone Nav Arrows */}
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={handleZoneUp}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
              data-testid="button-zone-up"
            >
              <ChevronUp className="w-6 h-6 text-black" />
            </button>
            <div className="text-xs text-gray-500 font-mono">
              ZN
            </div>
            <button
              onClick={handleZoneDown}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
              data-testid="button-zone-down"
            >
              <ChevronDown className="w-6 h-6 text-black" />
            </button>
          </div>

          {/* Channel Nav Arrows */}
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={handleChannelUp}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
              data-testid="button-channel-up"
            >
              <ChevronUp className="w-6 h-6 text-black" />
            </button>
            <div className="text-xs text-gray-500 font-mono">
              CH
            </div>
            <button
              onClick={handleChannelDown}
              className="w-10 h-10 bg-gray-100 rounded border border-gray-300 flex items-center justify-center active:bg-gray-200 active:scale-95 transition-all"
              data-testid="button-channel-down"
            >
              <ChevronDown className="w-6 h-6 text-black" />
            </button>
          </div>
        </div>
      </div>

      {/* Quick Actions Row */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowScanList(true)}
          className={cn(
            "flex-1 bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex flex-col items-center gap-1 active:bg-gray-50 transition-all",
            isScanning && "bg-green-50 border-green-300"
          )}
          data-testid="button-scan-list"
        >
          <List className="w-6 h-6 text-cyan-600" />
          <span className="text-xs text-gray-600 font-medium">Scan Lists</span>
        </button>
        
        <button
          onClick={handleOpenContacts}
          className="flex-1 bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex flex-col items-center gap-1 active:bg-gray-50 transition-all"
          data-testid="button-contacts"
        >
          <Users className="w-6 h-6 text-cyan-600" />
          <span className="text-xs text-gray-600 font-medium">Contacts</span>
        </button>
        
        <button
          onClick={() => setShowSettings(true)}
          className="flex-1 bg-white rounded-lg p-3 shadow-sm border border-gray-200 flex flex-col items-center gap-1 active:bg-gray-50 transition-all"
          data-testid="button-more"
        >
          <MoreHorizontal className="w-6 h-6 text-cyan-600" />
          <span className="text-xs text-gray-600 font-medium">More</span>
        </button>
      </div>

      {/* Messages Widget */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-3 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-cyan-600" />
            <span className="font-bold text-black">Clark, Robert</span>
          </div>
          <div className="text-sm text-gray-600 mt-1">On my way</div>
        </div>
        
        {/* Message Actions */}
        <div className="flex border-t border-gray-100">
          <button className="flex-1 py-3 flex items-center justify-center gap-2 text-cyan-600 font-medium text-sm border-r border-gray-100 active:bg-gray-50">
            <Plus className="w-4 h-4" />
            New Conversation
          </button>
          <button className="flex-1 py-3 flex items-center justify-center gap-2 text-cyan-600 font-medium text-sm active:bg-gray-50">
            <Mail className="w-4 h-4" />
            All Messages
          </button>
        </div>
      </div>

      {/* Emergency Button */}
      <button
        onClick={handleEmergencyToggle}
        className={cn(
          "w-full rounded-lg p-3 flex items-center justify-center gap-2 font-bold text-sm uppercase tracking-wider transition-all active:scale-98",
          isEmergency 
            ? "bg-red-600 text-white animate-pulse" 
            : "bg-white border border-gray-200 text-red-600 shadow-sm"
        )}
        data-testid="button-emergency"
      >
        <AlertTriangle className="w-5 h-5" />
        {isEmergency ? "EMERGENCY ACTIVE" : "EMERGENCY"}
      </button>

      {/* PTT Button (Toggleable) */}
      {showPTT && (
        <button
          onMouseDown={() => startTransmitting()}
          onMouseUp={() => stopTransmitting()}
          onMouseLeave={() => stopTransmitting()}
          onTouchStart={(e) => { e.preventDefault(); startTransmitting(); }}
          onTouchEnd={(e) => { e.preventDefault(); stopTransmitting(); }}
          onTouchCancel={() => stopTransmitting()}
          onContextMenu={(e) => { e.preventDefault(); stopTransmitting(); }}
          disabled={!liveKitConnected}
          className={cn(
            "w-full h-16 rounded-xl flex items-center justify-center font-bold text-lg uppercase tracking-widest transition-all active:scale-95 shadow-lg",
            !liveKitConnected 
              ? "bg-gray-300 text-gray-500 cursor-not-allowed"
              : isReceiving
                ? "bg-red-600 text-white"
                : "bg-cyan-600 text-white"
          )}
          data-testid="button-ptt"
        >
          {!liveKitConnected ? "CONNECTING..." : isReceiving ? `RX: ${activeSpeaker || 'RECEIVING'}` : "PUSH TO TALK"}
        </button>
      )}

      {/* Function Buttons and Widget - Draggable */}
      <div className="grid grid-cols-2 gap-2 flex-1 auto-rows-[4rem]">
        {functionButtons.map((btn) => (
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
            data-testid={btn.id === 'widget' ? 'widget-bottom' : `button-${btn.id}`}
          >
            <GripVertical className="w-4 h-4 text-gray-300 absolute left-2" />
            <div className="flex flex-col items-center">
              <span className="font-bold text-sm">{btn.label}</span>
              {btn.sublabel && <span className="text-xs text-gray-500">{btn.sublabel}</span>}
            </div>
          </div>
        ))}
      </div>


        {/* Scan List Modal */}
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
                  data-testid="button-toggle-scan"
                >
                  {isScanning ? "STOP" : "START"}
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-2">
                {scanChannels.map((ch, idx) => (
                  <label
                    key={ch.id}
                    className="flex items-center gap-3 p-3 bg-gray-100 rounded-lg cursor-pointer hover:bg-gray-200 transition-colors border border-gray-300"
                  >
                    <input
                      type="checkbox"
                      checked={ch.enabled}
                      onChange={() => toggleScanChannel(ch.id)}
                      className="w-5 h-5 accent-green-600"
                      data-testid={`checkbox-channel-${idx}`}
                    />
                    <span className="text-black font-mono">{ch.name}</span>
                  </label>
                ))}
              </div>
              <div className="p-4 border-t border-black">
                <button
                  onClick={() => setShowScanList(false)}
                  className="w-full py-3 bg-gray-200 text-black rounded-lg font-mono uppercase tracking-wider border border-black active:scale-95 transition-all"
                  data-testid="button-close-scan"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Settings Modal */}
        {showSettings && (
          <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm max-h-[80vh] flex flex-col">
              <div className="p-4 border-b border-black">
                <h2 className="text-black font-mono font-bold uppercase tracking-wider">Settings</h2>
              </div>
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                <label className="flex items-center justify-between p-3 bg-gray-100 rounded-lg cursor-pointer border border-gray-300">
                  <span className="text-black font-mono">Show PTT Button</span>
                  <input
                    type="checkbox"
                    checked={showPTT}
                    onChange={togglePTTVisibility}
                    className="w-5 h-5 accent-green-600"
                    data-testid="checkbox-show-ptt"
                  />
                </label>

                <div className="border-t border-gray-200 pt-4">
                  <h3 className="text-sm font-bold text-black mb-3">Customize F3 Button</h3>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={functionButtons.find(b => b.id === 'f3')?.label || ''}
                      onChange={(e) => {
                        const btn = functionButtons.find(b => b.id === 'f3');
                        if (btn) updateButtonLabel('f3', e.target.value, btn.sublabel);
                      }}
                      placeholder="Label"
                      className="w-full p-2 border border-gray-300 rounded-lg text-black"
                      data-testid="input-f3-label"
                    />
                    <input
                      type="text"
                      value={functionButtons.find(b => b.id === 'f3')?.sublabel || ''}
                      onChange={(e) => {
                        const btn = functionButtons.find(b => b.id === 'f3');
                        if (btn) updateButtonLabel('f3', btn.label, e.target.value);
                      }}
                      placeholder="Sublabel"
                      className="w-full p-2 border border-gray-300 rounded-lg text-black"
                      data-testid="input-f3-sublabel"
                    />
                  </div>
                </div>

                <div className="border-t border-gray-200 pt-4">
                  <h3 className="text-sm font-bold text-black mb-3">Customize F4 Button</h3>
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={functionButtons.find(b => b.id === 'f4')?.label || ''}
                      onChange={(e) => {
                        const btn = functionButtons.find(b => b.id === 'f4');
                        if (btn) updateButtonLabel('f4', e.target.value, btn.sublabel);
                      }}
                      placeholder="Label"
                      className="w-full p-2 border border-gray-300 rounded-lg text-black"
                      data-testid="input-f4-label"
                    />
                    <input
                      type="text"
                      value={functionButtons.find(b => b.id === 'f4')?.sublabel || ''}
                      onChange={(e) => {
                        const btn = functionButtons.find(b => b.id === 'f4');
                        if (btn) updateButtonLabel('f4', btn.label, e.target.value);
                      }}
                      placeholder="Sublabel"
                      className="w-full p-2 border border-gray-300 rounded-lg text-black"
                      data-testid="input-f4-sublabel"
                    />
                  </div>
                </div>
              </div>
              <div className="p-4 border-t border-black">
                <button
                  onClick={() => setShowSettings(false)}
                  className="w-full py-3 bg-gray-200 text-black rounded-lg font-mono uppercase tracking-wider border border-black active:scale-95 transition-all"
                  data-testid="button-close-settings"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Person Query Modal */}
        {showPersonQuery && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl border border-gray-200 w-full max-w-sm max-h-[85vh] flex flex-col shadow-xl">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-lg font-bold text-black">Person Query</h2>
                <button
                  onClick={() => setShowPersonQuery(false)}
                  className="text-gray-500 hover:text-black text-xl font-bold"
                  data-testid="button-close-person-query"
                >
                  ×
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                  <input
                    type="text"
                    value={personQueryForm.lastName}
                    onChange={(e) => setPersonQueryForm(prev => ({ ...prev, lastName: e.target.value }))}
                    placeholder="Enter last name"
                    className="w-full p-3 border border-gray-300 rounded-lg text-black"
                    data-testid="input-person-lastname"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                  <input
                    type="text"
                    value={personQueryForm.firstName}
                    onChange={(e) => setPersonQueryForm(prev => ({ ...prev, firstName: e.target.value }))}
                    placeholder="Enter first name"
                    className="w-full p-3 border border-gray-300 rounded-lg text-black"
                    data-testid="input-person-firstname"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Date of Birth</label>
                  <input
                    type="date"
                    value={personQueryForm.dob}
                    onChange={(e) => setPersonQueryForm(prev => ({ ...prev, dob: e.target.value }))}
                    className="w-full p-3 border border-gray-300 rounded-lg text-black"
                    data-testid="input-person-dob"
                  />
                </div>
                {queryError && (
                  <div className="p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm">
                    {queryError}
                  </div>
                )}
                <button
                  onClick={handlePersonQuery}
                  disabled={queryLoading}
                  className="w-full py-3 bg-cyan-600 text-white rounded-lg font-bold uppercase tracking-wider active:scale-95 transition-all disabled:opacity-50"
                  data-testid="button-submit-person-query"
                >
                  {queryLoading ? 'Searching...' : 'Search'}
                </button>
              </div>
              {queryResult && (
                <div className="flex-1 overflow-y-auto p-4 border-t border-gray-100">
                  <h3 className="font-bold text-sm text-gray-700 mb-2">Results ({queryResult.count || 0} found)</h3>
                  <div className="bg-gray-50 rounded-lg p-3 text-sm text-black space-y-3">
                    {(!queryResult.results || queryResult.results.length === 0) ? (
                      <p className="text-gray-500">No records found</p>
                    ) : (
                      queryResult.results.map((person: any, idx: number) => (
                        <div key={idx} className="border-b border-gray-200 pb-3 last:border-0 last:pb-0">
                          <p className="font-bold text-black">
                            {person.last_name?.toUpperCase()}, {person.first_name}
                          </p>
                          {person.dob && <p><span className="font-medium">DOB:</span> {person.dob}</p>}
                          {person.address && <p><span className="font-medium">Address:</span> {person.address}</p>}
                          {person.license_status && <p><span className="font-medium">License:</span> {person.license_status}</p>}
                          {person.ssn_last4 && <p><span className="font-medium">SSN:</span> ***-**-{person.ssn_last4}</p>}
                          {person.warrants && person.warrants.length > 0 && (
                            <div className="mt-2 p-2 bg-red-100 border border-red-300 rounded">
                              <p className="font-bold text-red-700">WARRANTS</p>
                              {person.warrants.map((w: any, i: number) => (
                                <p key={i} className="text-red-700">{typeof w === 'string' ? w : w.description || JSON.stringify(w)}</p>
                              ))}
                            </div>
                          )}
                          {person.flags && person.flags.length > 0 && (
                            <div className="mt-2 p-2 bg-yellow-100 border border-yellow-300 rounded">
                              <p className="font-bold text-yellow-700">FLAGS</p>
                              {person.flags.map((f: any, i: number) => (
                                <p key={i} className="text-yellow-700">{typeof f === 'string' ? f : f.description || JSON.stringify(f)}</p>
                              ))}
                            </div>
                          )}
                          {person.bolos && person.bolos.length > 0 && (
                            <div className="mt-2 p-2 bg-orange-100 border border-orange-300 rounded">
                              <p className="font-bold text-orange-700">BOLO</p>
                              {person.bolos.map((b: any, i: number) => (
                                <p key={i} className="text-orange-700">{typeof b === 'string' ? b : b.description || JSON.stringify(b)}</p>
                              ))}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Vehicle Query Modal */}
        {showVehicleQuery && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl border border-gray-200 w-full max-w-sm max-h-[85vh] flex flex-col shadow-xl">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-lg font-bold text-black">Vehicle Query</h2>
                <button
                  onClick={() => setShowVehicleQuery(false)}
                  className="text-gray-500 hover:text-black text-xl font-bold"
                  data-testid="button-close-vehicle-query"
                >
                  ×
                </button>
              </div>
              <div className="p-4 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">License Plate</label>
                  <input
                    type="text"
                    value={vehicleQueryForm.plate}
                    onChange={(e) => setVehicleQueryForm(prev => ({ ...prev, plate: e.target.value.toUpperCase() }))}
                    placeholder="Enter plate number"
                    className="w-full p-3 border border-gray-300 rounded-lg text-black uppercase"
                    data-testid="input-vehicle-plate"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">State</label>
                  <input
                    type="text"
                    value={vehicleQueryForm.state}
                    onChange={(e) => setVehicleQueryForm(prev => ({ ...prev, state: e.target.value.toUpperCase() }))}
                    placeholder="CA, TX, NY..."
                    maxLength={2}
                    className="w-full p-3 border border-gray-300 rounded-lg text-black uppercase"
                    data-testid="input-vehicle-state"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">VIN (optional)</label>
                  <input
                    type="text"
                    value={vehicleQueryForm.vin}
                    onChange={(e) => setVehicleQueryForm(prev => ({ ...prev, vin: e.target.value.toUpperCase() }))}
                    placeholder="Enter VIN"
                    className="w-full p-3 border border-gray-300 rounded-lg text-black uppercase"
                    data-testid="input-vehicle-vin"
                  />
                </div>
                {queryError && (
                  <div className="p-3 bg-red-100 border border-red-300 rounded-lg text-red-700 text-sm">
                    {queryError}
                  </div>
                )}
                <button
                  onClick={handleVehicleQuery}
                  disabled={queryLoading}
                  className="w-full py-3 bg-cyan-600 text-white rounded-lg font-bold uppercase tracking-wider active:scale-95 transition-all disabled:opacity-50"
                  data-testid="button-submit-vehicle-query"
                >
                  {queryLoading ? 'Searching...' : 'Search'}
                </button>
              </div>
              {queryResult && (
                <div className="flex-1 overflow-y-auto p-4 border-t border-gray-100">
                  <h3 className="font-bold text-sm text-gray-700 mb-2">Results</h3>
                  <div className="bg-gray-50 rounded-lg p-3 text-sm text-black space-y-2">
                    {queryResult.found === false ? (
                      <p className="text-gray-500">No records found</p>
                    ) : (
                      <>
                        {queryResult.plate && <p><span className="font-medium">Plate:</span> {queryResult.plate}</p>}
                        {queryResult.state && <p><span className="font-medium">State:</span> {queryResult.state}</p>}
                        {queryResult.make && <p><span className="font-medium">Make:</span> {queryResult.make}</p>}
                        {queryResult.model && <p><span className="font-medium">Model:</span> {queryResult.model}</p>}
                        {queryResult.year && <p><span className="font-medium">Year:</span> {queryResult.year}</p>}
                        {queryResult.color && <p><span className="font-medium">Color:</span> {queryResult.color}</p>}
                        {queryResult.owner && <p><span className="font-medium">Owner:</span> {queryResult.owner}</p>}
                        {queryResult.registration && <p><span className="font-medium">Registration:</span> {queryResult.registration}</p>}
                        {queryResult.stolen && (
                          <div className="mt-2 p-2 bg-red-100 border border-red-300 rounded">
                            <p className="font-bold text-red-700">STOLEN VEHICLE</p>
                          </div>
                        )}
                        {queryResult.alerts && queryResult.alerts.length > 0 && (
                          <div className="mt-2 p-2 bg-yellow-100 border border-yellow-300 rounded">
                            <p className="font-bold text-yellow-700">ALERTS</p>
                            {queryResult.alerts.map((a: any, i: number) => (
                              <p key={i} className="text-yellow-700">{a}</p>
                            ))}
                          </div>
                        )}
                        {!queryResult.plate && !queryResult.found && (
                          <pre className="text-xs overflow-auto">{JSON.stringify(queryResult, null, 2)}</pre>
                        )}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Contacts Modal */}
        {showContacts && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl border border-gray-200 w-full max-w-md max-h-[85vh] flex flex-col shadow-xl">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-lg font-bold text-black">Contacts</h2>
                <button
                  onClick={() => setShowContacts(false)}
                  className="text-gray-500 hover:text-black text-xl font-bold"
                  data-testid="button-close-contacts"
                >
                  ×
                </button>
              </div>
              <div className="flex-1 overflow-y-auto">
                {contactsLoading ? (
                  <div className="p-8 text-center text-gray-500">Loading contacts...</div>
                ) : contacts.length === 0 ? (
                  <div className="p-8 text-center text-gray-500">No contacts found</div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {contacts.map((contact) => (
                      <div 
                        key={contact.id} 
                        className="p-3 hover:bg-gray-50"
                        data-testid={`contact-row-${contact.id}`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="font-bold text-black text-sm">{contact.unit_id}</div>
                          <div className="text-gray-700 text-sm">{contact.last_name}</div>
                        </div>
                        <div className="mt-1 text-xs text-gray-500 space-y-0.5">
                          {contact.phone && (
                            <div className="flex items-center gap-1">
                              <span className="text-gray-400">Phone:</span>
                              <a 
                                href={`tel:${contact.phone}`} 
                                className="text-cyan-600"
                                data-testid={`link-phone-${contact.id}`}
                              >
                                {contact.phone}
                              </a>
                            </div>
                          )}
                          {contact.email && (
                            <div className="flex items-center gap-1">
                              <span className="text-gray-400">Email:</span>
                              <a 
                                href={`mailto:${contact.email}`} 
                                className="text-cyan-600 truncate"
                                data-testid={`link-email-${contact.id}`}
                              >
                                {contact.email}
                              </a>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
    </div>
  );
}
