import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useChannelStore = create(
  persist(
    (set, get) => ({
      channels: [],
      channelOrder: [],
      monitoredChannels: new Set(),
      mutedChannels: new Set(),
      channelLevels: {},
      activeTransmissions: {},
      primaryTxChannelId: null,
      
      setChannels: (channels) => set({ channels }),
      
      setChannelOrder: (order) => set({ channelOrder: order }),
      
      toggleMonitor: (channelId) => set((state) => {
        const monitored = new Set(state.monitoredChannels);
        if (monitored.has(channelId)) {
          monitored.delete(channelId);
        } else {
          monitored.add(channelId);
        }
        return { monitoredChannels: monitored };
      }),
      
      toggleMute: (channelId) => set((state) => {
        const muted = new Set(state.mutedChannels);
        if (muted.has(channelId)) {
          muted.delete(channelId);
        } else {
          muted.add(channelId);
        }
        return { mutedChannels: muted };
      }),
      
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
      
      setPrimaryTxChannel: (channelId) => set({ primaryTxChannelId: channelId }),
      
      getChannelById: (id) => get().channels.find(c => c.id === id),
      getChannelByName: (name) => get().channels.find(c => c.name === name),
    }),
    {
      name: 'dispatch-channels',
      partialize: (state) => ({
        channelOrder: state.channelOrder,
        monitoredChannels: Array.from(state.monitoredChannels),
        mutedChannels: Array.from(state.mutedChannels),
        primaryTxChannelId: state.primaryTxChannelId,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.monitoredChannels = new Set(state.monitoredChannels || []);
          state.mutedChannels = new Set(state.mutedChannels || []);
        }
      },
    }
  )
);
