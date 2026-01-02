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
import ChannelChat from '../components/ChannelChat/index.jsx';

import useDispatchStore from '../state/dispatchStore.js';
import { micPTTManager } from '../audio/MicPTTManager.js';
import toneEngine from '../audio/toneEngine.js';
import { getUnits } from '../utils/api.js';
import { useLiveKitConnection } from '../context/LiveKitConnectionContext.jsx';

export default function DispatchConsole({ user, onLogout }) {
  const [rightTab, setRightTab] = useState('emergency');
  const [showChannelPicker, setShowChannelPicker] = useState(false);
  const [selectedChatChannel, setSelectedChatChannel] = useState(null);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('dispatchDarkMode');
    return saved !== null ? JSON.parse(saved) : true;
  });

  const { retryConnection } = useLiveKitConnection();

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
  } = useDispatchStore();

  const sensors = useSensors(
    useSensor(PointerSensor),
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
      micPTTManager.disconnect();
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
      
      <div className="flex flex-1 overflow-hidden">
        <div className="w-64 p-3 border-r border-dispatch-border overflow-y-auto scrollbar-thin">
          <UnitList />
        </div>
        
        <div className="flex-1 p-3 overflow-y-auto scrollbar-thin">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold text-dispatch-text">Channels</h2>
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
            <div className="text-center text-dispatch-secondary py-8">
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
                  ? 'bg-dispatch-panel text-dispatch-text border-b-2 border-red-500'
                  : 'text-dispatch-secondary hover:text-dispatch-text'
              }`}
            >
              Emergency
            </button>
            <button
              onClick={() => setRightTab('patches')}
              className={`flex-1 px-4 py-2 text-sm ${
                rightTab === 'patches'
                  ? 'bg-dispatch-panel text-dispatch-text border-b-2 border-blue-500'
                  : 'text-dispatch-secondary hover:text-dispatch-text'
              }`}
            >
              Patches
            </button>
            <button
              onClick={() => setRightTab('events')}
              className={`flex-1 px-4 py-2 text-sm ${
                rightTab === 'events'
                  ? 'bg-dispatch-panel text-dispatch-text border-b-2 border-green-500'
                  : 'text-dispatch-secondary hover:text-dispatch-text'
              }`}
            >
              Events
            </button>
            <button
              onClick={() => setRightTab('chat')}
              className={`flex-1 px-4 py-2 text-sm ${
                rightTab === 'chat'
                  ? 'bg-dispatch-panel text-dispatch-text border-b-2 border-purple-500'
                  : 'text-dispatch-secondary hover:text-dispatch-text'
              }`}
            >
              Chat
            </button>
          </div>
          
          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {rightTab === 'emergency' && <EmergencyPanel />}
            {rightTab === 'patches' && <PatchPanel />}
            {rightTab === 'events' && <EventLog />}
            {rightTab === 'chat' && (
              <div className="flex flex-col h-full">
                <div className="px-3 py-2 border-b border-dispatch-border">
                  <select
                    value={selectedChatChannel || orderedChannels[0]?.name || ''}
                    onChange={(e) => setSelectedChatChannel(e.target.value)}
                    className="w-full px-2 py-1 text-sm bg-dispatch-bg text-dispatch-text border border-dispatch-border rounded"
                  >
                    {orderedChannels.map(ch => (
                      <option key={ch.id} value={ch.name}>{ch.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 overflow-hidden">
                  <ChannelChat 
                    channel={selectedChatChannel || orderedChannels[0]?.name} 
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
      />
      
      {showChannelPicker && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-dispatch-panel rounded-lg p-4 w-80 max-h-96 overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-dispatch-text">Add Channel</h3>
              <button
                onClick={() => setShowChannelPicker(false)}
                className="text-dispatch-secondary hover:text-dispatch-text"
              >
                &times;
              </button>
            </div>
            
            {availableChannels.length === 0 ? (
              <p className="text-dispatch-secondary text-center py-4">All channels added</p>
            ) : (
              <div className="space-y-2">
                {availableChannels.map(channel => (
                  <button
                    key={channel.id}
                    onClick={() => handleAddChannel(channel.id)}
                    className="w-full px-3 py-2 text-left bg-dispatch-bg hover:bg-dispatch-border rounded text-dispatch-text"
                  >
                    {channel.name}
                    <span className="text-xs text-dispatch-secondary ml-2">{channel.zone}</span>
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
