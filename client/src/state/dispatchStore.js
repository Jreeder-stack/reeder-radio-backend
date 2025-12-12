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
      
      units: [],
      emergencies: [],
      events: [],
      patches: [],
      
      pttState: 'idle',
      activeTxChannel: null,
      
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
      
      setUnits: (units) => set({ units }),
      
      updateUnit: (identity, updates) => set((state) => ({
        units: state.units.map(u => 
          u.unit_identity === identity ? { ...u, ...updates } : u
        )
      })),
      
      addEmergency: (emergency) => set((state) => ({
        emergencies: [...state.emergencies.filter(e => e.id !== emergency.id), emergency]
      })),
      
      removeEmergency: (id) => set((state) => ({
        emergencies: state.emergencies.filter(e => e.id !== id)
      })),
      
      clearEmergencies: () => set({ emergencies: [] }),
      
      setEvents: (events) => set({ events }),
      
      addEvent: (event) => set((state) => ({
        events: [event, ...state.events].slice(0, 100)
      })),
      
      setPatches: (patches) => set({ patches }),
      
      setPttState: (pttState) => set({ pttState }),
      
      setActiveTxChannel: (channelId) => set({ activeTxChannel: channelId }),
      
      getChannelById: (id) => {
        return get().channels.find(ch => ch.id === id);
      },
      
      getGridChannels: () => {
        const state = get();
        return state.gridChannelIds
          .map(id => state.channels.find(ch => ch.id === id))
          .filter(Boolean);
      },
      
      reset: () => set({
        channels: [],
        channelOrder: [],
        gridChannelIds: [],
        txChannelIds: [],
        mutedChannelIds: [],
        monitoredChannelIds: [],
        units: [],
        emergencies: [],
        events: [],
        patches: [],
        pttState: 'idle',
        activeTxChannel: null
      })
    }),
    {
      name: 'dispatch-store',
      partialize: (state) => ({
        channelOrder: state.channelOrder,
        gridChannelIds: state.gridChannelIds,
        txChannelIds: state.txChannelIds,
        mutedChannelIds: state.mutedChannelIds,
        monitoredChannelIds: state.monitoredChannelIds
      })
    }
  )
);

export default useDispatchStore;
