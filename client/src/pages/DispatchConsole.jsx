import { useEffect, useCallback, useState, useRef } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable';

import TopBar from '../components/TopBar/index.jsx';
import BottomBar from '../components/BottomBar/index.jsx';
import ChannelTile from '../components/ChannelTile/index.jsx';
import UnitList from '../components/UnitList/index.jsx';
import EmergencyPanel from '../components/EmergencyPanel/index.jsx';
import EventLog from '../components/EventLog/index.jsx';
import PatchPanel from '../components/PatchPanel/index.jsx';
import ChannelChat from '../components/ChannelChat/index.jsx';

import useDispatchStore from '../state/dispatchStore.js';
import toneEngine from '../audio/toneEngine.js';
import { getUnits } from '../utils/api.js';
import { useAudioConnection } from '../context/AudioConnectionContext.jsx';
import audioTransportManager from '../audio/AudioTransportManager.js';
import { useSignalingContext } from '../context/SignalingContext.jsx';
import formatChannelDisplay from '../utils/formatChannelDisplay.js';

export default function DispatchConsole({ user, onLogout }) {
  const [rightTab, setRightTab] = useState('emergency');
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  const [selectedChatChannel, setSelectedChatChannel] = useState(null);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('dispatchDarkMode');
    return saved !== null ? JSON.parse(saved) : true;
  });

  const MIN_LEFT = 180;
  const MIN_CENTER = 300;
  const MIN_RIGHT = 200;

  const [panelWidths, setPanelWidths] = useState(() => {
    try {
      const saved = localStorage.getItem('dispatchPanelWidths');
      if (saved) return JSON.parse(saved);
    } catch {}
    return { left: 256, right: 320 };
  });

  const containerRef = useRef(null);
  const draggingRef = useRef(null);
  const startXRef = useRef(0);
  const startWidthsRef = useRef({ left: 256, right: 320 });

  const handleResizeStart = useCallback((side, e) => {
    e.preventDefault();
    draggingRef.current = side;
    startXRef.current = e.clientX;
    startWidthsRef.current = { ...panelWidths };

    const handleMouseMove = (moveEvent) => {
      if (!draggingRef.current || !containerRef.current) return;
      const containerWidth = containerRef.current.offsetWidth;
      const delta = moveEvent.clientX - startXRef.current;

      if (draggingRef.current === 'left') {
        const newLeft = Math.max(MIN_LEFT, Math.min(startWidthsRef.current.left + delta, containerWidth - startWidthsRef.current.right - MIN_CENTER));
        setPanelWidths(prev => {
          const updated = { ...prev, left: newLeft };
          localStorage.setItem('dispatchPanelWidths', JSON.stringify(updated));
          return updated;
        });
      } else if (draggingRef.current === 'right') {
        const newRight = Math.max(MIN_RIGHT, Math.min(startWidthsRef.current.right - delta, containerWidth - startWidthsRef.current.left - MIN_CENTER));
        setPanelWidths(prev => {
          const updated = { ...prev, right: newRight };
          localStorage.setItem('dispatchPanelWidths', JSON.stringify(updated));
          return updated;
        });
      }
    };

    const handleMouseUp = () => {
      draggingRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidths]);

  useEffect(() => {
    const normalize = () => {
      if (!containerRef.current) return;
      const w = containerRef.current.offsetWidth;
      setPanelWidths(prev => {
        const maxLeft = w - prev.right - MIN_CENTER;
        const maxRight = w - prev.left - MIN_CENTER;
        const left = Math.max(MIN_LEFT, Math.min(prev.left, maxLeft));
        const right = Math.max(MIN_RIGHT, Math.min(prev.right, maxRight));
        if (left !== prev.left || right !== prev.right) {
          const updated = { left, right };
          localStorage.setItem('dispatchPanelWidths', JSON.stringify(updated));
          return updated;
        }
        return prev;
      });
    };
    normalize();
    window.addEventListener('resize', normalize);
    return () => window.removeEventListener('resize', normalize);
  }, []);

  const { retryConnection, connectToChannel, disconnectFromChannel } = useAudioConnection();
  const { 
    connected: signalingConnected,
    authenticated: signalingAuthenticated,
    channelMembers, 
    activeTransmissions,
    emergencyChannels,
    joinChannel,
    leaveChannel,
    isTransmitting,
    getTransmittingUnit,
    isEmergencyActive,
    signalPttStart,
    signalPttEnd,
  } = useSignalingContext();

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.remove('light-theme');
    } else {
      document.documentElement.classList.add('light-theme');
    }
  }, [darkMode]);

  const toggleTheme = () => {
    setDarkMode(prev => {
      const next = !prev;
      localStorage.setItem('dispatchDarkMode', JSON.stringify(next));
      return next;
    });
  };
  
  const {
    channels,
    channelOrder,
    setChannelOrder,
    gridChannelIds,
    addToGrid,
    removeFromGrid,
    setUnits,
    addEvent,
    setDispatcher,
    isConnected,
    isConnecting,
    connectionError,
    monitoredChannelIds,
  } = useDispatchStore();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    setDispatcher(user?.id, user?.username || 'DISPATCH');
  }, [user, setDispatcher]);


  useEffect(() => {
    const fetchUnits = async () => {
      try {
        const data = await getUnits();
        setUnits(data.units || []);
      } catch (err) {
        console.error('Failed to fetch units:', err);
      }
    };
    
    fetchUnits();
    const interval = setInterval(fetchUnits, 5000);
    
    return () => clearInterval(interval);
  }, [setUnits]);

  useEffect(() => {
    return () => {
      audioTransportManager.disconnect();
      toneEngine.destroy();
    };
  }, []);

  useEffect(() => {
    if (!signalingAuthenticated || !channels.length) return;
    
    const roomKeys = gridChannelIds
      .map(id => {
        const ch = channels.find(c => c.id === id);
        return ch ? (ch.room_key || ((ch.zone || 'Default') + '__' + ch.name)) : null;
      })
      .filter(Boolean);

    let cancelled = false;
    const joinAll = async () => {
      for (const rk of roomKeys) {
        if (cancelled) return;
        try {
          await joinChannel(rk);
        } catch (err) {
          console.error('[DispatchConsole] Failed to join channel:', rk, err);
        }
      }
    };
    joinAll();
    
    return () => {
      cancelled = true;
      roomKeys.forEach(rk => {
        leaveChannel(rk);
      });
    };
  }, [signalingAuthenticated, gridChannelIds, channels, joinChannel, leaveChannel]);

  const prevMonitoredRef = useRef([]);
  useEffect(() => {
    if (!channels.length) return;

    const identity = user?.unit_id || user?.username || 'Dispatch';

    const monitoredRoomKeys = monitoredChannelIds
      .map(id => {
        const ch = channels.find(c => c.id === id);
        return ch ? (ch.room_key || ((ch.zone || 'Default') + '__' + ch.name)) : null;
      })
      .filter(Boolean);

    const prevRoomKeys = prevMonitoredRef.current;

    const toConnect = monitoredRoomKeys.filter(rk => !prevRoomKeys.includes(rk));
    const toDisconnect = prevRoomKeys.filter(rk => !monitoredRoomKeys.includes(rk));

    toConnect.forEach(rk => {
      connectToChannel(rk, identity, true);
    });

    toDisconnect.forEach(rk => {
      disconnectFromChannel(rk);
    });

    prevMonitoredRef.current = monitoredRoomKeys;
  }, [monitoredChannelIds, channels, user, connectToChannel, disconnectFromChannel]);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    
    if (active.id !== over?.id) {
      const currentOrder = channelOrder.length > 0 ? channelOrder : gridChannelIds;
      const oldIndex = currentOrder.indexOf(Number(active.id));
      const newIndex = currentOrder.indexOf(Number(over.id));
      
      if (oldIndex !== -1 && newIndex !== -1) {
        setChannelOrder(arrayMove(currentOrder, oldIndex, newIndex));
      }
    }
  };

  const handlePTTStart = (channelNames) => {
    for (const channelName of channelNames) {
      addEvent({
        type: 'ptt_start',
        unit: user?.username || 'DISPATCH',
        channel: channelName,
      });
    }
  };

  const handlePTTEnd = (channelNames) => {
    for (const channelName of channelNames) {
      addEvent({
        type: 'ptt_end',
        unit: user?.username || 'DISPATCH',
        channel: channelName,
      });
    }
  };

  const handleToneTransmit = async (channelNames, toneType, duration) => {
    addEvent({
      type: 'tone',
      unit: user?.username || 'DISPATCH',
      channel: channelNames.join(', '),
      data: { toneType, duration },
    });
  };

  const handleRemoveChannel = (channelId) => {
    removeFromGrid(channelId);
    setChannelOrder(channelOrder.filter(id => id !== channelId));
  };

  const handleAddChannel = (channelId) => {
    addToGrid(channelId);
    if (!channelOrder.includes(channelId)) {
      setChannelOrder([...channelOrder, channelId]);
    }
    setShowChannelPicker(false);
  };

  const displayOrder = channelOrder.length > 0 ? channelOrder : gridChannelIds;
  const orderedChannels = displayOrder
    .map(id => channels.find(c => c.id === id))
    .filter(Boolean);

  const availableChannels = channels.filter(c => !gridChannelIds.includes(c.id));

  if (!isConnected && !isConnecting && connectionError) {
    return (
      <div className="flex flex-col h-screen bg-dispatch-bg">
        <TopBar user={user} onLogout={onLogout} darkMode={darkMode} onToggleTheme={toggleTheme} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl text-red-500 mb-4">Connection Failed</h2>
            <p className="text-dispatch-secondary mb-6">{connectionError}</p>
            <button
              onClick={retryConnection}
              className="btn-primary"
            >
              Retry Connection
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (isConnecting) {
    return (
      <div className="flex flex-col h-screen bg-dispatch-bg">
        <TopBar user={user} onLogout={onLogout} darkMode={darkMode} onToggleTheme={toggleTheme} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-xl text-dispatch-text mb-4">Connecting to channels...</div>
            <div className="text-dispatch-secondary">Please wait</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-dispatch-bg">
      <TopBar user={user} onLogout={onLogout} darkMode={darkMode} onToggleTheme={toggleTheme} />
      
      <div className="flex flex-1 overflow-hidden" ref={containerRef}>
        <div className="p-3 overflow-y-auto scrollbar-thin" style={{ width: panelWidths.left, minWidth: MIN_LEFT, flexShrink: 0 }}>
          <UnitList />
        </div>

        <div
          className="dispatch-resize-handle"
          onMouseDown={(e) => handleResizeStart('left', e)}
        />
        
        <div className="flex-1 p-3 overflow-y-auto scrollbar-thin min-w-0">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-dispatch-text">Channels</h2>
            <button
              onClick={() => setShowChannelPicker(true)}
              className="add-channel-btn"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              Add Channel
            </button>
          </div>
          
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={orderedChannels.map(c => c.id)}
              strategy={rectSortingStrategy}
            >
              <div className="channel-tile-grid">
                {orderedChannels.map(channel => (
                  <ChannelTile
                    key={channel.id}
                    channel={channel}
                    onRemove={() => handleRemoveChannel(channel.id)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          
          {orderedChannels.length === 0 && (
            <div className="text-center text-dispatch-secondary py-8">
              No channels in grid. Click "Add Channel" to add channels.
            </div>
          )}
        </div>
        
        <div
          className="dispatch-resize-handle"
          onMouseDown={(e) => handleResizeStart('right', e)}
        />
        <div className="min-w-0 flex flex-col dispatch-sidebar" style={{ width: panelWidths.right, minWidth: MIN_RIGHT, flexShrink: 0 }}>
          <div className="flex overflow-x-auto border-b border-dispatch-border">
            <button
              onClick={() => setRightTab('emergency')}
              className={`dispatch-tab ${rightTab === 'emergency' ? 'active active-emergency' : ''}`}
            >
              Emergency
            </button>
            <button
              onClick={() => setRightTab('patches')}
              className={`dispatch-tab ${rightTab === 'patches' ? 'active active-patches' : ''}`}
            >
              Patches
            </button>
            <button
              onClick={() => setRightTab('events')}
              className={`dispatch-tab ${rightTab === 'events' ? 'active active-events' : ''}`}
            >
              Events
            </button>
            <button
              onClick={() => setRightTab('playback')}
              className={`dispatch-tab ${rightTab === 'playback' ? 'active active-playback' : ''}`}
            >
              Playback
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {rightTab === 'emergency' && <EmergencyPanel />}
            {rightTab === 'patches' && <PatchPanel />}
            {rightTab === 'events' && <EventLog />}
            {rightTab === 'playback' && (
              <div className="flex flex-col h-full">
                <div className="px-3 py-2 border-b border-dispatch-border">
                  <select
                    value={selectedChatChannel || (orderedChannels[0] ? (orderedChannels[0].room_key || ((orderedChannels[0].zone || 'Default') + '__' + orderedChannels[0].name)) : '')}
                    onChange={(e) => setSelectedChatChannel(e.target.value)}
                    className="dispatch-select"
                  >
                    {orderedChannels.map(ch => (
                      <option key={ch.id} value={ch.room_key || ((ch.zone || 'Default') + '__' + ch.name)}>{formatChannelDisplay(ch.zone, ch.name)}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 overflow-hidden">
                  <ChannelChat 
                    channel={selectedChatChannel || (orderedChannels[0] ? (orderedChannels[0].room_key || ((orderedChannels[0].zone || 'Default') + '__' + orderedChannels[0].name)) : null)} 
                    currentUser={user}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      
      <BottomBar
        onPTTStart={handlePTTStart}
        onPTTEnd={handlePTTEnd}
        onToneTransmit={handleToneTransmit}
        identity={user?.unit_id || user?.username || 'Dispatch'}
        signalPttStart={signalPttStart}
        signalPttEnd={signalPttEnd}
      />
      
      {showChannelPicker && (
        <div className="dispatch-modal-overlay">
          <div className="dispatch-modal w-80">
            <div className="dispatch-modal-header">
              <h3 className="dispatch-modal-title">Add Channel</h3>
              <button
                onClick={() => setShowChannelPicker(false)}
                className="dispatch-modal-close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            {availableChannels.length === 0 ? (
              <p className="text-dispatch-secondary text-center py-4">All channels added</p>
            ) : (
              <div className="space-y-1.5">
                {availableChannels.map(channel => (
                  <button
                    key={channel.id}
                    onClick={() => handleAddChannel(channel.id)}
                    className="w-full px-3 py-2.5 text-left bg-dispatch-panel-elevated hover:bg-dispatch-border rounded-md text-dispatch-text transition-colors flex items-center justify-between group"
                  >
                    <span className="font-medium">{formatChannelDisplay(channel.zone, channel.name)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
