import { create } from 'zustand';

export const useUnitStore = create((set, get) => ({
  units: [],
  unitsByChannel: {},
  emergencyUnits: [],
  filter: 'all',
  
  setUnits: (units) => {
    const unitsByChannel = {};
    const emergencyUnits = [];
    
    units.forEach(unit => {
      const channel = unit.channel || 'unknown';
      if (!unitsByChannel[channel]) {
        unitsByChannel[channel] = [];
      }
      unitsByChannel[channel].push(unit);
      
      if (unit.is_emergency) {
        emergencyUnits.push(unit);
      }
    });
    
    set({ units, unitsByChannel, emergencyUnits });
  },
  
  updateUnit: (unitId, updates) => set((state) => {
    const units = state.units.map(u => 
      u.id === unitId ? { ...u, ...updates } : u
    );
    
    const unitsByChannel = {};
    const emergencyUnits = [];
    
    units.forEach(unit => {
      const channel = unit.channel || 'unknown';
      if (!unitsByChannel[channel]) {
        unitsByChannel[channel] = [];
      }
      unitsByChannel[channel].push(unit);
      
      if (unit.is_emergency) {
        emergencyUnits.push(unit);
      }
    });
    
    return { units, unitsByChannel, emergencyUnits };
  }),
  
  setFilter: (filter) => set({ filter }),
  
  getFilteredUnits: () => {
    const { units, filter, emergencyUnits } = get();
    switch (filter) {
      case 'online':
        return units.filter(u => {
          const lastSeen = new Date(u.last_seen);
          const now = new Date();
          return (now - lastSeen) < 60000;
        });
      case 'emergency':
        return emergencyUnits;
      default:
        return units;
    }
  },
  
  getUnitsByChannel: (channel) => get().unitsByChannel[channel] || [],
}));
