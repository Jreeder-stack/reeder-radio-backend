import { getRuntimeContext } from './runtimeContext.js';

const TTL_MS = 2 * 60 * 1000;
const GEOCODE_CACHE_TTL_MS = 5 * 60 * 1000;
const FORWARD_GEOCODE_CACHE_TTL_MS = 10 * 60 * 1000;
const GEOCODE_PRECISION = 4;

function clean(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalized(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripTrailingLocation(address, fields) {
  const parts = clean(address).split(',').map(clean).filter(Boolean);
  const tokens = fields.map(normalized).filter(Boolean);
  while (parts.length > 1) {
    const tail = normalized(parts[parts.length - 1]);
    const tailWithoutZip = tail.replace(/\b\d{5}(?:\s*\d{4})?\b/g, '').trim();
    if (!tokens.some((token) => tail === token || tailWithoutZip === token)) break;
    parts.pop();
  }
  return parts.join(', ');
}

function cleanPremise(value) {
  const premise = clean(value);
  return premise.includes(',') ? premise.split(',')[0].trim() : premise;
}

function normalizeAddressRecord(record, source) {
  if (!record || typeof record !== 'object') return null;
  const lat = Number(record.latitude ?? record.lat);
  const lng = Number(record.longitude ?? record.lng ?? record.lon);
  const rawAddress = record.address || record.streetAddress || record.formatted_address || null;
  const postalCity = record.city || record.town || record.village || null;
  const municipality = record.municipality || record.township || postalCity || null;
  const rawState = record.state || null;
  const postcode = record.zipCode || record.zip_code || record.postcode || null;
  const businessName = cleanPremise(record.businessName || record.business_name || record.name || null);
  if (!rawAddress && !businessName) return null;

  let streetAddress = stripTrailingLocation(rawAddress || '', [
    municipality,
    postalCity,
    rawState,
    postcode,
  ]);
  const houseNumber = clean(record.houseNumber || record.house_number);
  if (houseNumber && streetAddress && !new RegExp(`^${houseNumber}\\b`, 'i').test(streetAddress)) {
    streetAddress = `${houseNumber} ${streetAddress}`;
  }

  const isNamedPremise = !!businessName && !!streetAddress;
  const road = isNamedPremise
    ? `${businessName} — ${streetAddress}`
    : streetAddress || businessName;
  const spokenMunicipality = municipality || postalCity;

  return {
    displayName: [road, spokenMunicipality, isNamedPremise ? null : rawState]
      .filter(Boolean).join(', '),
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    // A decorated named-premise road already contains the house number. Keep
    // houseNumber null so the dispatcher verifier does not prepend it twice.
    houseNumber: isNamedPremise ? null : houseNumber || null,
    road,
    city: spokenMunicipality,
    postalCity,
    township: record.township || null,
    municipality: spokenMunicipality,
    county: record.county || null,
    // Named premises are read back without a redundant state suffix. The
    // original state remains available as postalState for mapping/debugging.
    state: isNamedPremise ? null : rawState,
    postalState: rawState,
    postcode,
    importance: source === 'MAI' ? 1 : 0.85,
    addressType: source === 'MAI' ? 'master_address_index' : 'place',
    businessName: businessName || null,
    streetAddress: streetAddress || null,
    source,
    maiAddressId: record.id || record.addressId || null,
    googlePlaceId: record.place_id || record.placeId || null,
    premiseNotes: record.premiseNotes || record.notes || null,
    gateCode: record.gateCode || null,
    keyHolderName: record.keyHolderName || null,
    keyHolderPhone: record.keyHolderPhone || null,
  };
}

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
    if (!unitId || typeof lat !== 'number' || typeof lng !== 'number') return false;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
    const location = { unitId, lat, lng, accuracy, channel, timestamp: Date.now() };
    this.locations.set(unitId, location);
    this.broadcast({ type: 'update', location });
    return true;
  }

  getLocation(unitId) {
    const loc = this.locations.get(unitId);
    return loc && Date.now() - loc.timestamp < TTL_MS ? loc : null;
  }

  getAllLocations() {
    const now = Date.now();
    return [...this.locations.values()].filter(loc => now - loc.timestamp < TTL_MS);
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
    res.on('close', () => this.sseClients.delete(res));
    res.write(`data: ${JSON.stringify({ type: 'init', locations: this.getAllLocations() })}\n\n`);
  }

  broadcast(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) client.write(message);
  }

  _geocodeCacheKey(lat, lng) {
    return `${lat.toFixed(GEOCODE_PRECISION)},${lng.toFixed(GEOCODE_PRECISION)}`;
  }

  _cleanGeocodeCache() {
    const now = Date.now();
    for (const [key, entry] of this._geocodeCache) {
      if (now - entry.timestamp >= GEOCODE_CACHE_TTL_MS) this._geocodeCache.delete(key);
    }
    for (const [key, entry] of this._forwardGeocodeCache) {
      if (now - entry.timestamp >= FORWARD_GEOCODE_CACHE_TTL_MS) this._forwardGeocodeCache.delete(key);
    }
  }

  cacheForwardGeocodeAlias(address, result) {
    if (!address || typeof address !== 'string' || !result) return;
    this._forwardGeocodeCache.set(address.trim().toLowerCase(), {
      result,
      timestamp: Date.now(),
    });
  }

  async _searchCadLocation(query) {
    const runtime = getRuntimeContext();
    const cadUrl = String(runtime.cadUrl || process.env.CAD_URL || '').replace(/\/+$/, '');
    const apiKey = runtime.cadApiKey || process.env.CAD_API_KEY || '';
    if (!cadUrl || !apiKey) return null;

    try {
      const url = new URL(`${cadUrl}/api/radio/locations/resolve`);
      url.searchParams.set('q', query);
      const response = await fetch(url, {
        headers: {
          'X-API-Key': apiKey,
          ...(runtime.dispatchCenterId ? { 'X-Dispatch-Center-Id': runtime.dispatchCenterId } : {}),
          ...(runtime.agencyId ? { 'X-Agency-Id': runtime.agencyId } : {}),
        },
        signal: AbortSignal.timeout(6500),
      });

      if (!response.ok) {
        console.log(`[LocationService] CAD location resolver HTTP error: ${response.status}`);
        return null;
      }

      const payload = await response.json();
      if (!payload?.success || !payload?.location) return null;
      return normalizeAddressRecord(payload.location, payload.source || 'CAD_RESOLVER');
    } catch (error) {
      console.log(`[LocationService] CAD location resolver error: ${error.message}`);
      return null;
    }
  }

  async _searchNominatim(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&addressdetails=1&limit=1&countrycodes=us`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'CommandComms-Dispatcher/1.0', 'Accept-Language': 'en' },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const top = data[0];
    const a = top.address || {};
    return {
      displayName: top.display_name || null,
      lat: parseFloat(top.lat),
      lng: parseFloat(top.lon),
      houseNumber: a.house_number || null,
      road: a.road || a.pedestrian || a.neighbourhood || top.name || null,
      city: a.city || a.town || a.village || null,
      township: a.township || a.village || null,
      municipality: a.township || a.city || a.town || a.village || a.municipality || null,
      county: a.county || null,
      state: a.state || null,
      postcode: a.postcode || null,
      importance: typeof top.importance === 'number' ? top.importance : null,
      addressType: top.addresstype || top.type || null,
      source: 'NOMINATIM',
    };
  }

  async forwardGeocode(address) {
    if (!address || typeof address !== 'string') return null;
    const query = address.trim();
    const cacheKey = query.toLowerCase();
    const cached = this._forwardGeocodeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < FORWARD_GEOCODE_CACHE_TTL_MS) return cached.result;
    try {
      const result = await this._searchCadLocation(query)
        || await this._searchNominatim(query);
      this._forwardGeocodeCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      console.log(`[LocationService] Forward geocode error: ${error.message}`);
      return null;
    }
  }

  async reverseGeocode(lat, lng) {
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    const cacheKey = this._geocodeCacheKey(lat, lng);
    const cached = this._geocodeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < GEOCODE_CACHE_TTL_MS) return cached.address;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'CommandComms-Dispatcher/1.0', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return null;
      const data = await response.json();
      const a = data?.address || {};
      const address = [a.house_number, a.road || a.pedestrian, a.city || a.town || a.village, a.state]
        .filter(Boolean).join(', ') || data?.display_name || null;
      if (address) this._geocodeCache.set(cacheKey, { address, timestamp: Date.now() });
      return address;
    } catch (error) {
      console.log(`[LocationService] Reverse geocode error: ${error.message}`);
      return null;
    }
  }

  async getUnitAddress(unitId) {
    const loc = this.getLocation(unitId);
    if (!loc) return null;
    return {
      lat: loc.lat,
      lng: loc.lng,
      accuracy: loc.accuracy,
      address: await this.reverseGeocode(loc.lat, loc.lng),
      timestamp: loc.timestamp,
    };
  }
}

const locationService = new LocationService();
export default locationService;
