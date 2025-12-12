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

import useDispatchStore from '../state/dispatchStore.js';
import livekitManager from '../audio/LiveKitManager.js';
import { micPTTManager } from '../audio/MicPTTManager.js';
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
    addToGrid,
    removeFromGrid,
    setChannelLevel,
    setActiveTransmission,
    clearActiveTransmission,
    setUnits,
    addEvent,
    addEmergency,
    setDispatcher,
    isConnected,
    setConnected,
    isConnecting,
    setConnecting,
    connectionError,
    setConnectionError,
  } = useDispatchStore();

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
      
      if (gridChannelIds.length === 0 && dbChannels.length > 0) {
        const initialIds = dbChannels.map(c => c.id);
        initialIds.forEach(id => addToGrid(id));
        setChannelOrder(initialIds);
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  }, [setChannels, setUnits, gridChannelIds, addToGrid, setChannelOrder]);

  const connectToChannels = useCallback(async () => {
    if (isConnecting || isConnected) return;
    if (channels.length === 0) return;
    
    setConnecting(true);
    setConnectionError(null);
    
    try {
      setDispatcher(user?.id, user?.username || 'DISPATCH');
      
      livekitManager.onLevelUpdate = (channelName, level) => {
        const channel = channels.find(c => c.name === channelName);
        if (channel) {
          setChannelLevel(channel.id, level);
        }
      };
      
      livekitManager.onTrackSubscribed = (channelName, track, participant) => {
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
      
      livekitManager.onTrackUnsubscribed = (channelName, track, participant) => {
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
      
      livekitManager.onDataReceived = (channelName, message, participant) => {
        if (message.type === 'emergency') {
          if (message.active) {
            toneEngine.playEmergencyTone('B', 3000);
            addEmergency({
              id: `emergency-${participant.identity}-${Date.now()}`,
              unitIdentity: message.identity,
              channel: channelName,
              timestamp: new Date().toISOString(),
            });
            addEvent({
              type: 'emergency_activated',
              unit: message.identity,
              channel: channelName,
            });
          }
        }
      };
      
      const enabledChannels = channels.filter(c => c.enabled);
      console.log('[DispatchConsole] Connecting to channels:', enabledChannels.map(c => c.name));
      
      for (const channel of enabledChannels) {
        try {
          await livekitManager.connect(channel.name, user?.username || 'DISPATCH');
          console.log(`[DispatchConsole] Connected to ${channel.name}`);
          addEvent({
            type: 'connect',
            channel: channel.name,
          });
        } catch (err) {
          console.error(`Failed to connect to ${channel.name}:`, err);
        }
      }
      
      console.log('[DispatchConsole] All connections complete. Connected rooms:', livekitManager.getConnectedChannels());
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
    addEmergency,
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
      micPTTManager.disconnect();
      livekitManager.disconnectAll();
      toneEngine.destroy();
    };
  }, []);

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
        
        <div className="flex-1 p-3 overflow-y-auto scrollbar-thin">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-white">Channels</h2>
            <button
              onClick={() => setShowChannelPicker(true)}
              className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded"
            >
              + Add Channel
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
              <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
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
            <div className="text-center text-gray-500 py-8">
              No channels in grid. Click "Add Channel" to add channels.
            </div>
          )}
        </div>
        
        <div className="w-80 border-l border-dispatch-border flex flex-col">
          <div className="flex border-b border-dispatch-border">
            <button
              onClick={() => setRightTab('emergency')}
              className={`flex-1 px-4 py-2 text-sm ${
                rightTab === 'emergency'
                  ? 'bg-dispatch-panel text-white border-b-2 border-red-500'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Emergency
            </button>
            <button
              onClick={() => setRightTab('patches')}
              className={`flex-1 px-4 py-2 text-sm ${
                rightTab === 'patches'
                  ? 'bg-dispatch-panel text-white border-b-2 border-blue-500'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Patches
            </button>
            <button
              onClick={() => setRightTab('events')}
              className={`flex-1 px-4 py-2 text-sm ${
                rightTab === 'events'
                  ? 'bg-dispatch-panel text-white border-b-2 border-green-500'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Events
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {rightTab === 'emergency' && <EmergencyPanel />}
            {rightTab === 'patches' && <PatchPanel />}
            {rightTab === 'events' && <EventLog />}
          </div>
        </div>
      </div>
      
      <BottomBar
        onPTTStart={handlePTTStart}
        onPTTEnd={handlePTTEnd}
        onToneTransmit={handleToneTransmit}
      />
      
      {showChannelPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-dispatch-panel rounded-lg p-4 w-80 max-h-96 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">Add Channel</h3>
              <button
                onClick={() => setShowChannelPicker(false)}
                className="text-gray-400 hover:text-white"
              >
                &times;
              </button>
            </div>
            
            {availableChannels.length === 0 ? (
              <p className="text-gray-400 text-center py-4">All channels added</p>
            ) : (
              <div className="space-y-2">
                {availableChannels.map(channel => (
                  <button
                    key={channel.id}
                    onClick={() => handleAddChannel(channel.id)}
                    className="w-full px-3 py-2 text-left bg-dispatch-bg hover:bg-gray-700 rounded text-white"
                  >
                    {channel.name}
                    <span className="text-xs text-gray-400 ml-2">{channel.zone}</span>
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
