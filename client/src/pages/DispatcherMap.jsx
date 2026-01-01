import { useState, useEffect, useRef } from 'react';
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const API_BASE = '';

const STATUS_COLORS = {
  idle: '#22c55e',
  transmitting: '#eab308',
  emergency: '#dc2626',
  default: '#3b82f6'
};

function createUnitIcon(unitId, status = 'idle') {
  const color = STATUS_COLORS[status] || STATUS_COLORS.default;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="50" viewBox="0 0 40 50">
      <path d="M20 0C9 0 0 9 0 20c0 15 20 30 20 30s20-15 20-30C40 9 31 0 20 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
      <circle cx="20" cy="18" r="10" fill="#fff"/>
      <text x="20" y="22" text-anchor="middle" font-size="9" font-weight="bold" fill="${color}">${unitId.slice(0, 4)}</text>
    </svg>
  `;
  return L.divIcon({
    html: svg,
    className: 'unit-marker',
    iconSize: [40, 50],
    iconAnchor: [20, 50],
    popupAnchor: [0, -50]
  });
}

function MapBoundsUpdater({ locations }) {
  const map = useMap();
  
  useEffect(() => {
    if (locations.length > 0) {
      const bounds = L.latLngBounds(locations.map(loc => [loc.lat, loc.lng]));
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 });
    }
  }, [locations.length]);
  
  return null;
}

function formatTime(timestamp) {
  if (!timestamp) return 'Unknown';
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatAge(timestamp) {
  if (!timestamp) return '';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

export default function DispatcherMap() {
  const [locations, setLocations] = useState([]);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    function connect() {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const es = new EventSource(`${API_BASE}/api/location/stream`);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnected(true);
        console.log('Location stream connected');
      };

      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === 'init') {
            setLocations(data.locations || []);
          } else if (data.type === 'update') {
            setLocations(prev => {
              const filtered = prev.filter(loc => loc.unitId !== data.location.unitId);
              return [...filtered, data.location];
            });
          } else if (data.type === 'remove') {
            setLocations(prev => prev.filter(loc => loc.unitId !== data.unitId));
          }
        } catch (err) {
          console.error('Error parsing location data:', err);
        }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };
    }

    connect();

    const refreshInterval = setInterval(() => {
      setLocations(prev => [...prev]);
    }, 10000);

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      clearInterval(refreshInterval);
    };
  }, []);

  return (
    <div style={{ 
      width: '100vw', 
      height: '100vh', 
      display: 'flex', 
      flexDirection: 'column',
      background: '#1a1a2e'
    }}>
      <header style={{
        padding: '12px 20px',
        background: '#16213e',
        borderBottom: '1px solid #0f3460',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between'
      }}>
        <h1 style={{ 
          margin: 0, 
          fontSize: '20px', 
          color: '#fff',
          fontFamily: 'system-ui, -apple-system, sans-serif'
        }}>
          Unit Location Map
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <span style={{ 
            color: connected ? '#22c55e' : '#ef4444',
            fontSize: '14px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px'
          }}>
            <span style={{
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: connected ? '#22c55e' : '#ef4444'
            }} />
            {connected ? 'Connected' : 'Reconnecting...'}
          </span>
          <span style={{ color: '#94a3b8', fontSize: '14px' }}>
            {locations.length} unit{locations.length !== 1 ? 's' : ''} active
          </span>
        </div>
      </header>

      <div style={{ flex: 1, position: 'relative' }}>
        <MapContainer
          center={[39.8283, -98.5795]}
          zoom={4}
          style={{ height: '100%', width: '100%' }}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <MapBoundsUpdater locations={locations} />
          
          {locations.map(loc => (
            <Marker
              key={loc.unitId}
              position={[loc.lat, loc.lng]}
              icon={createUnitIcon(loc.unitId, loc.status)}
            >
              <Popup>
                <div style={{ minWidth: '150px' }}>
                  <strong style={{ fontSize: '14px' }}>{loc.unitId}</strong>
                  <div style={{ fontSize: '12px', color: '#666', marginTop: '4px' }}>
                    Channel: {loc.channel || 'Unknown'}
                  </div>
                  <div style={{ fontSize: '12px', color: '#666' }}>
                    Updated: {formatTime(loc.timestamp)}
                  </div>
                  <div style={{ fontSize: '11px', color: '#999' }}>
                    ({formatAge(loc.timestamp)})
                  </div>
                  {loc.accuracy && (
                    <div style={{ fontSize: '11px', color: '#999' }}>
                      Accuracy: {Math.round(loc.accuracy)}m
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>

        {locations.length === 0 && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            padding: '20px 30px',
            borderRadius: '8px',
            textAlign: 'center',
            pointerEvents: 'none'
          }}>
            <div style={{ fontSize: '16px', marginBottom: '8px' }}>No units reporting location</div>
            <div style={{ fontSize: '13px', color: '#94a3b8' }}>
              Unit locations will appear when they connect
            </div>
          </div>
        )}
      </div>

      <style>{`
        .unit-marker {
          background: transparent !important;
          border: none !important;
        }
        .leaflet-popup-content-wrapper {
          border-radius: 8px;
        }
      `}</style>
    </div>
  );
}
