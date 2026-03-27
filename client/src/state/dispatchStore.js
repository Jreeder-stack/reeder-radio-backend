import { create } from 'zustand';
import { persist } from 'zustand/middleware';

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
      
      pttState: 'idle',
      isTalking: false,
      activeTxChannelId: null,
      toneState: null,
      clearAirEnabled: {},
      clearAirChannel: null,

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
        const newEmergencies = [];
        
        units.forEach(unit => {
          const channel = unit.channel || 'unknown';
          if (!unitsByChannel[channel]) {
            unitsByChannel[channel] = [];
          }
          unitsByChannel[channel].push(unit);
          
          if (unit.is_emergency) {
            newEmergencies.push({
              id: `emergency-${unit.id}`,
              unitId: unit.id,
              unitIdentity: unit.unit_identity,
              channel: unit.channel,
              timestamp: unit.last_seen
            });
          }
        });
        
        const existingEmergencies = get().emergencies;
        const existingByKey = new Map();
        existingEmergencies.forEach(e => {
          existingByKey.set(e.unitIdentity || e.unitId, e);
        });
        const mergedEmergencies = newEmergencies.map(e => {
          const key = e.unitIdentity || e.unitId;
          const existing = existingByKey.get(key);
          if (existing) {
            return { ...e, acknowledged: existing.acknowledged || false };
          }
          return { ...e, acknowledged: false };
        });
        const newUnitKeys = new Set(newEmergencies.map(e => e.unitIdentity || e.unitId));
        const keptExisting = existingEmergencies.filter(e => !newUnitKeys.has(e.unitIdentity || e.unitId));
        const merged = [...keptExisting, ...mergedEmergencies];
        const seenUnits = new Set();
        const deduplicated = merged.filter(e => {
          const key = e.unitIdentity || e.unitId;
          if (seenUnits.has(key)) return false;
          seenUnits.add(key);
          return true;
        });
        
        set({ units, unitsByChannel, emergencies: deduplicated });
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
      
      addEmergency: (emergency) => set((state) => {
        const key = emergency.unitIdentity || emergency.unitId;
        return {
          emergencies: [...state.emergencies.filter(e => (e.unitIdentity || e.unitId) !== key), { ...emergency, acknowledged: false }]
        };
      }),
      
      acknowledgeEmergency: (id) => set((state) => ({
        emergencies: state.emergencies.map(e =>
          e.id === id ? { ...e, acknowledged: true } : e
        ),
      })),
      
      removeEmergency: (id) => set((state) => {
        const target = state.emergencies.find(e => e.id === id);
        if (target) {
          const key = target.unitIdentity || target.unitId;
          return { emergencies: state.emergencies.filter(e => (e.unitIdentity || e.unitId) !== key) };
        }
        return { emergencies: state.emergencies.filter(e => e.id !== id) };
      }),
      
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

      setClearAirChannel: (channelId) => set({ clearAirChannel: channelId }),
      
      getChannelById: (id) => get().channels.find(ch => ch.id === id),
      
      getChannelByName: (name) => get().channels.find(ch => ch.name === name),
      
      getTxChannelNames: () => {
        const state = get();
        return state.txChannelIds
          .map(id => {
            const ch = state.channels.find(c => c.id === id);
            return ch ? (ch.room_key || ((ch.zone || 'Default') + '__' + ch.name)) : null;
          })
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
        pttState: 'idle',
        isTalking: false,
        activeTxChannelId: null,
        toneState: null,
        clearAirEnabled: {},
        clearAirChannel: null
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
        channelLevels: state.channelLevels,
        clearAirEnabled: state.clearAirEnabled
      })
    }
  )
);

if (typeof window !== 'undefined') {
  window.__dispatchStore = useDispatchStore;
}

export default useDispatchStore;
