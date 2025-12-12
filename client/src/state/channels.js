import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useChannelStore = create(
  persist(
    (set, get) => ({
      channels: [],
      channelOrder: [],
      gridChannelIds: [],
      monitoredChannels: [],
      mutedChannels: [],
      selectedTxChannels: [],
      channelLevels: {},
      activeTransmissions: {},
      
      setChannels: (channels) => set((state) => {
        const validIds = new Set(channels.map(c => c.id));
        const validIdStrings = new Set(channels.map(c => c.id.toString()));
        return {
          channels,
          channelOrder: state.channelOrder.filter(id => validIdStrings.has(id)),
          gridChannelIds: state.gridChannelIds.filter(id => validIds.has(id)),
          monitoredChannels: state.monitoredChannels.filter(id => validIds.has(id)),
          mutedChannels: state.mutedChannels.filter(id => validIds.has(id)),
          selectedTxChannels: state.selectedTxChannels.filter(id => validIds.has(id)),
        };
      }),
      
      setChannelOrder: (order) => set({ channelOrder: order }),
      
      setGridChannelIds: (ids) => set({ gridChannelIds: ids }),
      
      addChannelToGrid: (channelId) => set((state) => {
        if (state.gridChannelIds.includes(channelId)) return state;
        const newIds = [...state.gridChannelIds, channelId];
        const newOrder = [...state.channelOrder, channelId.toString()];
        return { gridChannelIds: newIds, channelOrder: newOrder };
      }),
      
      removeChannelFromGrid: (channelId) => set((state) => {
        const newIds = state.gridChannelIds.filter(id => id !== channelId);
        const newOrder = state.channelOrder.filter(id => id !== channelId.toString());
        const newTx = state.selectedTxChannels.filter(id => id !== channelId);
        const newMonitored = state.monitoredChannels.filter(id => id !== channelId);
        const newMuted = state.mutedChannels.filter(id => id !== channelId);
        return { 
          gridChannelIds: newIds, 
          channelOrder: newOrder,
          selectedTxChannels: newTx,
          monitoredChannels: newMonitored,
          mutedChannels: newMuted,
        };
      }),
      
      toggleMonitor: (channelId) => set((state) => {
        const monitored = [...state.monitoredChannels];
        const idx = monitored.indexOf(channelId);
        if (idx >= 0) {
          monitored.splice(idx, 1);
        } else {
          monitored.push(channelId);
        }
        return { monitoredChannels: monitored };
      }),
      
      toggleMute: (channelId) => set((state) => {
        const muted = [...state.mutedChannels];
        const idx = muted.indexOf(channelId);
        if (idx >= 0) {
          muted.splice(idx, 1);
        } else {
          muted.push(channelId);
        }
        return { mutedChannels: muted };
      }),
      
      toggleTxChannel: (channelId) => set((state) => {
        const selected = [...state.selectedTxChannels];
        const idx = selected.indexOf(channelId);
        if (idx >= 0) {
          selected.splice(idx, 1);
        } else {
          selected.push(channelId);
        }
        return { selectedTxChannels: selected };
      }),
      
      setSelectedTxChannels: (channels) => set({ selectedTxChannels: channels }),
      
      isMonitored: (channelId) => get().monitoredChannels.includes(channelId),
      
      isMuted: (channelId) => get().mutedChannels.includes(channelId),
      
      isTxSelected: (channelId) => get().selectedTxChannels.includes(channelId),
      
      setChannelLevel: (channelId, level) => set((state) => ({
        channelLevels: { ...state.channelLevels, [channelId]: level }
      })),
      
      setActiveTransmission: (channelId, transmission) => set((state) => ({
        activeTransmissions: { ...state.activeTransmissions, [channelId]: transmission }
      })),
      
      clearActiveTransmission: (channelId) => set((state) => {
        const updated = { ...state.activeTransmissions };
        delete updated[channelId];
        return { activeTransmissions: updated };
      }),
      
      getChannelById: (id) => get().channels.find(c => c.id === id),
      getChannelByName: (name) => get().channels.find(c => c.name === name),
      
      getGridChannels: () => {
        const state = get();
        return state.channelOrder
          .map(id => state.channels.find(c => c.id.toString() === id))
          .filter(Boolean);
      },
      
      // Reset all persisted state (call on logout)
      resetStore: () => set({
        channels: [],
        channelOrder: [],
        gridChannelIds: [],
        monitoredChannels: [],
        mutedChannels: [],
        selectedTxChannels: [],
        channelLevels: {},
        activeTransmissions: {},
      }),
    }),
    {
      name: 'dispatch-channels',
      partialize: (state) => ({
        channelOrder: state.channelOrder,
        gridChannelIds: state.gridChannelIds,
        monitoredChannels: state.monitoredChannels,
        mutedChannels: state.mutedChannels,
        selectedTxChannels: state.selectedTxChannels,
      }),
    }
  )
);
