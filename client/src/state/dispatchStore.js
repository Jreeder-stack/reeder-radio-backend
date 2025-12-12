import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const PTT_STATES = {
  IDLE: 'idle',
  ARMING: 'arming',
  TRANSMITTING: 'transmitting',
  COOLDOWN: 'cooldown'
};

const useDispatchStore = create(
  persist(
    (set, get) => ({
      channels: [],
      channelOrder: [],
      gridChannelIds: [],
      txChannelIds: [],
      mutedChannelIds: [],
      monitoredChannelIds: [],
      channelLevels: {},
      activeTransmissions: {},
      
      units: [],
      unitsByChannel: {},
      emergencies: [],
      events: [],
      patches: [],
      
      dispatcherId: null,
      dispatcherName: '',
      isConnected: false,
      isConnecting: false,
      connectionError: null,
      
      pttState: PTT_STATES.IDLE,
      isTalking: false,
      activeTxChannelId: null,
      toneState: null,
      clearAirEnabled: {},

      setChannels: (newChannels) => {
        const validIds = new Set(newChannels.map(ch => ch.id));
        const state = get();
        
        set({
          channels: newChannels,
          channelOrder: state.channelOrder.filter(id => validIds.has(id)),
          gridChannelIds: state.gridChannelIds.filter(id => validIds.has(id)),
          txChannelIds: state.txChannelIds.filter(id => validIds.has(id)),
          mutedChannelIds: state.mutedChannelIds.filter(id => validIds.has(id)),
          monitoredChannelIds: state.monitoredChannelIds.filter(id => validIds.has(id))
        });
      },
      
      setChannelOrder: (order) => set({ channelOrder: order }),
      
      addToGrid: (channelId) => set((state) => ({
        gridChannelIds: state.gridChannelIds.includes(channelId) 
          ? state.gridChannelIds 
          : [...state.gridChannelIds, channelId]
      })),
      
      removeFromGrid: (channelId) => set((state) => ({
        gridChannelIds: state.gridChannelIds.filter(id => id !== channelId),
        txChannelIds: state.txChannelIds.filter(id => id !== channelId),
        mutedChannelIds: state.mutedChannelIds.filter(id => id !== channelId),
        monitoredChannelIds: state.monitoredChannelIds.filter(id => id !== channelId)
      })),
      
      toggleTx: (channelId) => set((state) => ({
        txChannelIds: state.txChannelIds.includes(channelId)
          ? state.txChannelIds.filter(id => id !== channelId)
          : [...state.txChannelIds, channelId]
      })),
      
      setTxChannels: (ids) => set({ txChannelIds: ids }),
      
      toggleMute: (channelId) => set((state) => ({
        mutedChannelIds: state.mutedChannelIds.includes(channelId)
          ? state.mutedChannelIds.filter(id => id !== channelId)
          : [...state.mutedChannelIds, channelId]
      })),
      
      toggleMonitor: (channelId) => set((state) => ({
        monitoredChannelIds: state.monitoredChannelIds.includes(channelId)
          ? state.monitoredChannelIds.filter(id => id !== channelId)
          : [...state.monitoredChannelIds, channelId]
      })),

      setChannelLevel: (channelId, level) => set((state) => ({
        channelLevels: { ...state.channelLevels, [channelId]: level }
      })),

      setActiveTransmission: (channelId, tx) => set((state) => ({
        activeTransmissions: { ...state.activeTransmissions, [channelId]: tx }
      })),

      clearActiveTransmission: (channelId) => set((state) => {
        const updated = { ...state.activeTransmissions };
        delete updated[channelId];
        return { activeTransmissions: updated };
      }),
      
      setUnits: (units) => {
        const unitsByChannel = {};
        const emergencies = [];
        
        units.forEach(unit => {
          const channel = unit.channel || 'unknown';
          if (!unitsByChannel[channel]) {
            unitsByChannel[channel] = [];
          }
          unitsByChannel[channel].push(unit);
          
          if (unit.is_emergency) {
            emergencies.push({
              id: `emergency-${unit.id}`,
              unitId: unit.id,
              unitIdentity: unit.unit_identity,
              channel: unit.channel,
              timestamp: unit.last_seen
            });
          }
        });
        
        set({ units, unitsByChannel, emergencies });
      },
      
      updateUnit: (identity, updates) => set((state) => {
        const units = state.units.map(u => 
          u.unit_identity === identity ? { ...u, ...updates } : u
        );
        
        const unitsByChannel = {};
        units.forEach(unit => {
          const channel = unit.channel || 'unknown';
          if (!unitsByChannel[channel]) {
            unitsByChannel[channel] = [];
          }
          unitsByChannel[channel].push(unit);
        });
        
        return { units, unitsByChannel };
      }),
      
      addEmergency: (emergency) => set((state) => ({
        emergencies: [...state.emergencies.filter(e => e.id !== emergency.id), emergency]
      })),
      
      removeEmergency: (id) => set((state) => ({
        emergencies: state.emergencies.filter(e => e.id !== id)
      })),
      
      clearEmergencies: () => set({ emergencies: [] }),
      
      setEvents: (events) => set({ events }),
      
      addEvent: (event) => set((state) => ({
        events: [
          { ...event, id: Date.now(), timestamp: new Date().toISOString() },
          ...state.events
        ].slice(0, 100)
      })),
      
      setPatches: (patches) => set({ patches }),

      setDispatcher: (id, name) => set({ dispatcherId: id, dispatcherName: name }),
      
      setConnected: (connected) => set({ 
        isConnected: connected, 
        isConnecting: false, 
        connectionError: null 
      }),
      
      setConnecting: (connecting) => set({ isConnecting: connecting }),
      
      setConnectionError: (error) => set({ 
        connectionError: error, 
        isConnecting: false 
      }),
      
      setPttState: (pttState) => set({ pttState }),
      
      setTalking: (isTalking) => set({ isTalking }),
      
      setActiveTxChannel: (channelId) => set({ activeTxChannelId: channelId }),

      setToneState: (tone) => set({ toneState: tone }),

      toggleClearAir: (channelId) => set((state) => ({
        clearAirEnabled: {
          ...state.clearAirEnabled,
          [channelId]: !state.clearAirEnabled[channelId]
        }
      })),
      
      getChannelById: (id) => get().channels.find(ch => ch.id === id),
      
      getChannelByName: (name) => get().channels.find(ch => ch.name === name),
      
      getTxChannelNames: () => {
        const state = get();
        return state.txChannelIds
          .map(id => state.channels.find(ch => ch.id === id)?.name)
          .filter(Boolean);
      },
      
      getGridChannels: () => {
        const state = get();
        return state.gridChannelIds
          .map(id => state.channels.find(ch => ch.id === id))
          .filter(Boolean);
      },

      getUnitsByChannel: (channelName) => get().unitsByChannel[channelName] || [],
      
      resetStore: () => set({
        channels: [],
        channelOrder: [],
        gridChannelIds: [],
        txChannelIds: [],
        mutedChannelIds: [],
        monitoredChannelIds: [],
        channelLevels: {},
        activeTransmissions: {},
        units: [],
        unitsByChannel: {},
        emergencies: [],
        events: [],
        patches: [],
        dispatcherId: null,
        dispatcherName: '',
        isConnected: false,
        isConnecting: false,
        connectionError: null,
        pttState: PTT_STATES.IDLE,
        isTalking: false,
        activeTxChannelId: null,
        toneState: null,
        clearAirEnabled: {}
      })
    }),
    {
      name: 'dispatch-store',
      partialize: (state) => ({
        channelOrder: state.channelOrder,
        gridChannelIds: state.gridChannelIds,
        txChannelIds: state.txChannelIds,
        mutedChannelIds: state.mutedChannelIds,
        monitoredChannelIds: state.monitoredChannelIds,
        clearAirEnabled: state.clearAirEnabled
      })
    }
  )
);

export { PTT_STATES, useDispatchStore };
export default useDispatchStore;
