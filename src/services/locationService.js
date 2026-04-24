const TTL_MS = 2 * 60 * 1000; // 2 minutes
const GEOCODE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const FORWARD_GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GEOCODE_PRECISION = 4; // ~11m precision for cache keys

class LocationService {
  constructor() {
    this.locations = new Map();
    this.sseClients = new Set();
    this._geocodeCache = new Map();
    this._forwardGeocodeCache = new Map();
    
    setInterval(() => this.cleanExpired(), 30000);
    setInterval(() => this._cleanGeocodeCache(), 60000);
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

  _geocodeCacheKey(lat, lng) {
    return `${lat.toFixed(GEOCODE_PRECISION)},${lng.toFixed(GEOCODE_PRECISION)}`;
  }

  _cleanGeocodeCache() {
    const now = Date.now();
    for (const [key, entry] of this._geocodeCache) {
      if (now - entry.timestamp >= GEOCODE_CACHE_TTL_MS) {
        this._geocodeCache.delete(key);
      }
    }
    for (const [key, entry] of this._forwardGeocodeCache) {
      if (now - entry.timestamp >= FORWARD_GEOCODE_CACHE_TTL_MS) {
        this._forwardGeocodeCache.delete(key);
      }
    }
  }

  async forwardGeocode(address) {
    if (!address || typeof address !== 'string') {
      return null;
    }

    const cacheKey = address.trim().toLowerCase();
    const cached = this._forwardGeocodeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < FORWARD_GEOCODE_CACHE_TTL_MS) {
      return cached.result;
    }

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&addressdetails=1&limit=1`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'CommandComms-Dispatcher/1.0',
          'Accept-Language': 'en'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        console.log(`[LocationService] Forward geocode HTTP error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) {
        this._forwardGeocodeCache.set(cacheKey, { result: null, timestamp: Date.now() });
        return null;
      }

      const top = data[0];
      const a = top.address || {};

      const result = {
        displayName: top.display_name || null,
        lat: parseFloat(top.lat),
        lng: parseFloat(top.lon),
        // Task #542: surface the raw street parts so the AI dispatcher can
        // build a canonical "house# road, city, ST" address for CAD instead
        // of trusting the spoken spelling.
        houseNumber: a.house_number || null,
        road: a.road || a.pedestrian || null,
        city: a.city || a.town || a.village || null,
        township: a.township || a.village || null,
        municipality: a.city || a.town || a.village || a.municipality || null,
        county: a.county || null,
        state: a.state || null,
        postcode: a.postcode || null,
        importance: typeof top.importance === 'number' ? top.importance : null,
        addressType: top.addresstype || top.type || null,
      };

      this._forwardGeocodeCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.log(`[LocationService] Forward geocode error: ${error.message}`);
      return null;
    }
  }

  async reverseGeocode(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return null;
    }

    const cacheKey = this._geocodeCacheKey(lat, lng);
    const cached = this._geocodeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < GEOCODE_CACHE_TTL_MS) {
      return cached.address;
    }

    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'CommandComms-Dispatcher/1.0',
          'Accept-Language': 'en'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        console.log(`[LocationService] Reverse geocode HTTP error: ${response.status}`);
        return null;
      }

      const data = await response.json();
      let address = null;

      if (data && data.address) {
        const a = data.address;
        const parts = [];
        if (a.house_number) parts.push(a.house_number);
        if (a.road) parts.push(a.road);
        if (!a.road && a.pedestrian) parts.push(a.pedestrian);
        if (a.city || a.town || a.village) parts.push(a.city || a.town || a.village);
        if (a.state) parts.push(a.state);
        address = parts.length > 0 ? parts.join(', ') : (data.display_name || null);
      } else if (data && data.display_name) {
        address = data.display_name;
      }

      if (address) {
        this._geocodeCache.set(cacheKey, { address, timestamp: Date.now() });
      }

      return address;
    } catch (error) {
      console.log(`[LocationService] Reverse geocode error: ${error.message}`);
      return null;
    }
  }

  async getUnitAddress(unitId) {
    const loc = this.getLocation(unitId);
    if (!loc) return null;

    const address = await this.reverseGeocode(loc.lat, loc.lng);
    return {
      lat: loc.lat,
      lng: loc.lng,
      accuracy: loc.accuracy,
      address: address,
      timestamp: loc.timestamp
    };
  }
}

const locationService = new LocationService();

export default locationService;
