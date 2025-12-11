import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const useChannelStore = create(
  persist(
    (set, get) => ({
      channels: [],
      channelOrder: [],
      monitoredChannels: [],
      mutedChannels: [],
      channelLevels: {},
      activeTransmissions: {},
      primaryTxChannelId: null,
      
      setChannels: (channels) => set({ channels }),
      
      setChannelOrder: (order) => set({ channelOrder: order }),
      
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
      
      isMonitored: (channelId) => get().monitoredChannels.includes(channelId),
      
      isMuted: (channelId) => get().mutedChannels.includes(channelId),
      
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
        monitoredChannels: state.monitoredChannels,
        mutedChannels: state.mutedChannels,
        primaryTxChannelId: state.primaryTxChannelId,
      }),
    }
  )
);
