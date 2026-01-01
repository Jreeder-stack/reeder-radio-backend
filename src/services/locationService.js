const TTL_MS = 2 * 60 * 1000; // 2 minutes

class LocationService {
  constructor() {
    this.locations = new Map();
    this.sseClients = new Set();
    
    setInterval(() => this.cleanExpired(), 30000);
  }

  updateLocation(unitId, lat, lng, accuracy = null, channel = null) {
    if (!unitId || typeof lat !== 'number' || typeof lng !== 'number') {
      return false;
    }
    
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return false;
    }

    const location = {
      unitId,
      lat,
      lng,
      accuracy,
      channel,
      timestamp: Date.now()
    };

    this.locations.set(unitId, location);
    this.broadcast({ type: 'update', location });
    return true;
  }

  getLocation(unitId) {
    const loc = this.locations.get(unitId);
    if (loc && Date.now() - loc.timestamp < TTL_MS) {
      return loc;
    }
    return null;
  }

  getAllLocations() {
    const now = Date.now();
    const result = [];
    
    for (const [unitId, loc] of this.locations) {
      if (now - loc.timestamp < TTL_MS) {
        result.push(loc);
      }
    }
    
    return result;
  }

  cleanExpired() {
    const now = Date.now();
    for (const [unitId, loc] of this.locations) {
      if (now - loc.timestamp >= TTL_MS) {
        this.locations.delete(unitId);
        this.broadcast({ type: 'remove', unitId });
      }
    }
  }

  addSSEClient(res) {
    this.sseClients.add(res);
    
    res.on('close', () => {
      this.sseClients.delete(res);
    });

    const locations = this.getAllLocations();
    res.write(`data: ${JSON.stringify({ type: 'init', locations })}\n\n`);
  }

  broadcast(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      client.write(message);
    }
  }
}

const locationService = new LocationService();

export default locationService;
