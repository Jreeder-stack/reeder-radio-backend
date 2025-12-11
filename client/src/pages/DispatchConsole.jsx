import { useEffect, useCallback, useState } from 'react';
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

import { useChannelStore } from '../state/channels.js';
import { useUnitStore } from '../state/units.js';
import { useDispatcherStore } from '../state/dispatcher.js';

import livekitEngine from '../audio/livekitEngine.js';
import toneEngine from '../audio/toneEngine.js';
import { getUnits } from '../utils/api.js';

export default function DispatchConsole({ user, onLogout }) {
  const [rightTab, setRightTab] = useState('emergency');
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  
  const {
    channels,
    setChannels,
    channelOrder,
    setChannelOrder,
    gridChannelIds,
    setGridChannelIds,
    addChannelToGrid,
    removeChannelFromGrid,
    selectedTxChannels,
    setChannelLevel,
    setActiveTransmission,
    clearActiveTransmission,
  } = useChannelStore();

  const { setUnits, updateUnit } = useUnitStore();
  
  const {
    setDispatcher,
    isConnected,
    setConnected,
    isConnecting,
    setConnecting,
    connectionError,
    setConnectionError,
    addEvent,
  } = useDispatcherStore();

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const fetchChannelsAndUnits = useCallback(async () => {
    try {
      const [channelRes, unitData] = await Promise.all([
        fetch('/api/channels', { credentials: 'include' }),
        getUnits(),
      ]);
      
      if (!channelRes.ok) {
        console.error('Failed to fetch channels');
        return;
      }
      
      const channelData = await channelRes.json();
      const dbChannels = channelData.channels || [];
      
      setChannels(dbChannels);
      setUnits(unitData.units || []);
      
      const validDbIds = new Set(dbChannels.map(c => c.id));
      
      if (gridChannelIds.length === 0 && dbChannels.length > 0) {
        const initialIds = dbChannels.map(c => c.id);
        setGridChannelIds(initialIds);
        setChannelOrder(initialIds.map(id => id.toString()));
      } else if (gridChannelIds.length > 0) {
        const validGridIds = gridChannelIds.filter(id => validDbIds.has(id));
        const validOrderIds = channelOrder.filter(id => validDbIds.has(parseInt(id, 10)));
        
        if (validGridIds.length !== gridChannelIds.length) {
          setGridChannelIds(validGridIds);
          setChannelOrder(validOrderIds);
        }
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  }, [setChannels, setUnits, gridChannelIds, channelOrder, setGridChannelIds, setChannelOrder]);

  const connectToChannels = useCallback(async () => {
    if (isConnecting || isConnected) return;
    if (channels.length === 0) return;
    
    setConnecting(true);
    setConnectionError(null);
    
    try {
      setDispatcher(user?.id, user?.username || 'DISPATCH');
      
      livekitEngine.onLevelUpdate = (channelName, level) => {
        const channel = channels.find(c => c.name === channelName);
        if (channel) {
          setChannelLevel(channel.id, level);
        }
      };
      
      livekitEngine.onTrackSubscribed = (channelName, track, participant) => {
        const channel = channels.find(c => c.name === channelName);
        if (channel) {
          setActiveTransmission(channel.id, {
            from: participant.identity,
            timestamp: Date.now(),
          });
        }
        addEvent({
          type: 'ptt_start',
          unit: participant.identity,
          channel: channelName,
        });
      };
      
      livekitEngine.onTrackUnsubscribed = (channelName, track, participant) => {
        const channel = channels.find(c => c.name === channelName);
        if (channel) {
          clearActiveTransmission(channel.id);
        }
        addEvent({
          type: 'ptt_end',
          unit: participant.identity,
          channel: channelName,
        });
      };
      
      livekitEngine.onDataReceived = (channelName, message, participant) => {
        if (message.type === 'emergency') {
          if (message.active) {
            toneEngine.playEmergencyTone('B', 3000);
            addEvent({
              type: 'emergency_activated',
              unit: message.identity,
              channel: channelName,
            });
          }
        }
      };
      
      const enabledChannels = channels.filter(c => c.enabled);
      for (const channel of enabledChannels) {
        try {
          await livekitEngine.connectToChannel(channel.name, user?.username || 'DISPATCH');
          addEvent({
            type: 'connect',
            channel: channel.name,
          });
        } catch (err) {
          console.error(`Failed to connect to ${channel.name}:`, err);
        }
      }
      
      try {
        await livekitEngine.initPersistentMic();
        console.log('[DispatchConsole] Persistent mic initialized');
      } catch (err) {
        console.error('[DispatchConsole] Failed to initialize persistent mic:', err);
      }
      
      setConnected(true);
    } catch (error) {
      console.error('Connection error:', error);
      setConnectionError(error.message);
    } finally {
      setConnecting(false);
    }
  }, [
    isConnecting, 
    isConnected, 
    user, 
    channels, 
    setDispatcher, 
    setConnecting, 
    setConnectionError, 
    setConnected,
    setChannelLevel,
    setActiveTransmission,
    clearActiveTransmission,
    addEvent,
  ]);

  useEffect(() => {
    fetchChannelsAndUnits();
  }, [fetchChannelsAndUnits]);

  useEffect(() => {
    if (channels.length > 0 && !isConnected && !isConnecting) {
      connectToChannels();
    }
  }, [channels, isConnected, isConnecting, connectToChannels]);

  useEffect(() => {
    const interval = setInterval(() => {
      getUnits().then(data => {
        setUnits(data.units || []);
      }).catch(console.error);
    }, 5000);
    
    return () => clearInterval(interval);
  }, [setUnits]);

  useEffect(() => {
    return () => {
      livekitEngine.disconnectAll();
      toneEngine.destroy();
    };
  }, []);

  const handleDragEnd = (event) => {
    const { active, over } = event;
    
    if (active.id !== over?.id) {
      const oldIndex = channelOrder.indexOf(active.id);
      const newIndex = channelOrder.indexOf(over.id);
      
      setChannelOrder(arrayMove(channelOrder, oldIndex, newIndex));
    }
  };

  const handlePTTStart = async (channelNames) => {
    for (const channelName of channelNames) {
      try {
        const result = await livekitEngine.publishAudio(channelName);
        if (result) {
          addEvent({
            type: 'ptt_start',
            unit: user?.username || 'DISPATCH',
            channel: channelName,
          });
        }
      } catch (error) {
        console.error('PTT start error:', error);
      }
    }
  };

  const handlePTTEnd = async (channelNames) => {
    for (const channelName of channelNames) {
      try {
        await livekitEngine.unpublishAudio(channelName, null, null);
        addEvent({
          type: 'ptt_end',
          unit: user?.username || 'DISPATCH',
          channel: channelName,
        });
      } catch (error) {
        console.error('PTT end error:', error);
      }
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
    removeChannelFromGrid(channelId);
  };

  const orderedChannels = channelOrder
    .map(id => channels.find(c => c.id.toString() === id))
    .filter(Boolean);

  const availableChannels = channels.filter(c => !gridChannelIds.includes(c.id));

  if (!isConnected && !isConnecting && connectionError) {
    return (
      <div className="flex flex-col h-screen bg-dispatch-bg">
        <TopBar user={user} onLogout={onLogout} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl text-red-500 mb-4">Connection Failed</h2>
            <p className="text-gray-400 mb-6">{connectionError}</p>
            <button
              onClick={connectToChannels}
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
        <TopBar user={user} onLogout={onLogout} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-xl text-white mb-4">Connecting to channels...</div>
            <div className="text-gray-400">Please wait</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-dispatch-bg">
      <TopBar user={user} onLogout={onLogout} />
      
      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 p-3 border-r border-dispatch-border overflow-y-auto scrollbar-thin">
          <UnitList />
        </div>

        <div className="flex-1 p-4 overflow-y-auto scrollbar-thin">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-white">Channel Grid</h2>
            <button
              onClick={() => setShowChannelPicker(!showChannelPicker)}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
            >
              {showChannelPicker ? 'Close' : 'Add Channel'}
            </button>
          </div>

          {showChannelPicker && (
            <div className="mb-4 p-3 bg-dispatch-panel border border-dispatch-border rounded-lg">
              <h3 className="text-sm font-medium text-gray-300 mb-2">Available Channels</h3>
              {availableChannels.length === 0 ? (
                <p className="text-sm text-gray-500">All channels are already in the grid</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableChannels.map(channel => (
                    <button
                      key={channel.id}
                      onClick={() => {
                        addChannelToGrid(channel.id);
                      }}
                      className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-sm rounded transition-colors"
                    >
                      + {channel.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={channelOrder}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                {orderedChannels.map(channel => (
                  <ChannelTile
                    key={channel.id}
                    channel={channel}
                    onRemove={handleRemoveChannel}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          {orderedChannels.length === 0 && (
            <div className="flex items-center justify-center h-48 text-gray-500">
              <div className="text-center">
                <p className="mb-2">No channels in grid</p>
                <button
                  onClick={() => setShowChannelPicker(true)}
                  className="text-blue-400 hover:text-blue-300"
                >
                  Add channels to get started
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="w-72 border-l border-dispatch-border flex flex-col">
          <div className="flex border-b border-dispatch-border">
            <button
              onClick={() => setRightTab('emergency')}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                rightTab === 'emergency' 
                  ? 'bg-red-900/50 text-red-300 border-b-2 border-red-500' 
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Emergency
            </button>
            <button
              onClick={() => setRightTab('events')}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                rightTab === 'events' 
                  ? 'bg-blue-900/50 text-blue-300 border-b-2 border-blue-500' 
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Events
            </button>
            <button
              onClick={() => setRightTab('patches')}
              className={`flex-1 py-2 text-xs font-medium transition-colors ${
                rightTab === 'patches' 
                  ? 'bg-purple-900/50 text-purple-300 border-b-2 border-purple-500' 
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Patches
            </button>
          </div>
          <div className="flex-1 p-3 overflow-hidden">
            {rightTab === 'emergency' && <EmergencyPanel />}
            {rightTab === 'events' && <EventLog />}
            {rightTab === 'patches' && <PatchPanel />}
          </div>
        </div>
      </div>

      <BottomBar 
        onPTTStart={handlePTTStart} 
        onPTTEnd={handlePTTEnd} 
        onToneTransmit={handleToneTransmit}
      />
    </div>
  );
}
