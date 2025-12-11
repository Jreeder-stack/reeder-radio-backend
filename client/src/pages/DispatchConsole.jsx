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
import { getChannels, getUnits } from '../utils/api.js';

const ZONES = {
  "Zone 1 - Operations": ["OPS1", "OPS2", "TAC1"],
  "Zone 2 - Fire": ["FIRE1", "FIRE2", "FIRE3", "FIRE4", "FIRE5", "FIRE6", "FIRE7", "FIRE8"],
  "Zone 3 - Secure Command": ["SECURE_CMD"],
};

const ALL_CHANNEL_NAMES = Object.values(ZONES).flat();

export default function DispatchConsole({ user, onLogout }) {
  const [rightTab, setRightTab] = useState('emergency');
  
  const {
    channels,
    setChannels,
    channelOrder,
    setChannelOrder,
    primaryTxChannelId,
    setChannelLevel,
    setActiveTransmission,
    clearActiveTransmission,
    monitoredChannels,
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
      const [channelData, unitData] = await Promise.all([
        getChannels(),
        getUnits(),
      ]);
      
      const radioChannels = channelData.channels || [];
      
      const simulatedChannels = ALL_CHANNEL_NAMES.map((name, index) => {
        const existing = radioChannels.find(c => c.name === name);
        return existing || { id: index + 1000, name, is_active: true };
      });
      
      setChannels(simulatedChannels);
      setUnits(unitData.units || []);
      
      if (channelOrder.length === 0) {
        setChannelOrder(simulatedChannels.map(c => c.id.toString()));
      }
    } catch (error) {
      console.error('Failed to fetch data:', error);
    }
  }, [setChannels, setUnits, channelOrder, setChannelOrder]);

  const connectToAllChannels = useCallback(async () => {
    if (isConnecting || isConnected) return;
    
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
          const channel = channels.find(c => c.name === channelName);
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
      
      for (const channelName of ALL_CHANNEL_NAMES) {
        try {
          await livekitEngine.connectToChannel(channelName, user?.username || 'DISPATCH');
          addEvent({
            type: 'connect',
            channel: channelName,
          });
        } catch (err) {
          console.error(`Failed to connect to ${channelName}:`, err);
        }
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
      connectToAllChannels();
    }
  }, [channels, isConnected, isConnecting, connectToAllChannels]);

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

  const handlePTTStart = async (channelName) => {
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
  };

  const handlePTTEnd = async () => {
    const primaryChannel = channels.find(c => c.id === primaryTxChannelId);
    if (primaryChannel) {
      try {
        await livekitEngine.unpublishAudio(primaryChannel.name, null, null);
        addEvent({
          type: 'ptt_end',
          unit: user?.username || 'DISPATCH',
          channel: primaryChannel.name,
        });
      } catch (error) {
        console.error('PTT end error:', error);
      }
    }
  };

  const orderedChannels = channelOrder
    .map(id => channels.find(c => c.id.toString() === id))
    .filter(Boolean);

  if (!isConnected && !isConnecting && connectionError) {
    return (
      <div className="flex flex-col h-screen bg-dispatch-bg">
        <TopBar user={user} onLogout={onLogout} />
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <h2 className="text-xl text-red-500 mb-4">Connection Failed</h2>
            <p className="text-gray-400 mb-6">{connectionError}</p>
            <button
              onClick={connectToAllChannels}
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
                    isSelected={primaryTxChannelId === channel.id}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
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

      <BottomBar onPTTStart={handlePTTStart} onPTTEnd={handlePTTEnd} />
    </div>
  );
}
