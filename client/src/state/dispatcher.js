import { create } from 'zustand';

export const useDispatcherStore = create((set, get) => ({
  dispatcherId: null,
  dispatcherName: '',
  isConnected: false,
  isConnecting: false,
  connectionError: null,
  isTalking: false,
  clearAirEnabled: {},
  events: [],
  theme: 'dark',
  
  setDispatcher: (id, name) => set({ dispatcherId: id, dispatcherName: name }),
  
  setConnected: (connected) => set({ isConnected: connected, isConnecting: false, connectionError: null }),
  
  setConnecting: (connecting) => set({ isConnecting: connecting }),
  
  setConnectionError: (error) => set({ connectionError: error, isConnecting: false }),
  
  setTalking: (talking) => set({ isTalking: talking }),
  
  toggleClearAir: (channelId) => set((state) => ({
    clearAirEnabled: {
      ...state.clearAirEnabled,
      [channelId]: !state.clearAirEnabled[channelId]
    }
  })),
  
  addEvent: (event) => set((state) => ({
    events: [
      { ...event, id: Date.now(), timestamp: new Date().toISOString() },
      ...state.events.slice(0, 99)
    ]
  })),
  
  clearEvents: () => set({ events: [] }),
  
  toggleTheme: () => set((state) => ({
    theme: state.theme === 'dark' ? 'light' : 'dark'
  })),
}));
