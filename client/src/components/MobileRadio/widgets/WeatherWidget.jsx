import { useState, useEffect } from 'react';
import { X, Loader2, MapPin, Thermometer, Droplets, Wind } from 'lucide-react';

export function WeatherWidget({ show, onClose }) {
  const [weather, setWeather] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [location, setLocation] = useState(null);

  useEffect(() => {
    if (show && !weather) {
      getLocationAndWeather();
    }
  }, [show]);

  const getLocationAndWeather = async () => {
    setLoading(true);
    setError(null);

    try {
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            const { latitude, longitude } = position.coords;
            setLocation({ lat: latitude, lon: longitude });
            await fetchWeather(latitude, longitude);
          },
          async () => {
            await fetchWeather(39.7684, -86.1581);
          }
        );
      } else {
        await fetchWeather(39.7684, -86.1581);
      }
    } catch (err) {
      setError('Failed to get weather');
      setLoading(false);
    }
  };

  const fetchWeather = async (lat, lon) => {
    try {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`
      );
      const data = await response.json();
      
      if (data.current) {
        setWeather({
          temp: Math.round(data.current.temperature_2m),
          humidity: data.current.relative_humidity_2m,
          windSpeed: Math.round(data.current.wind_speed_10m),
          code: data.current.weather_code,
          location: data.timezone,
        });
      }
    } catch (err) {
      setError('Failed to fetch weather data');
    } finally {
      setLoading(false);
    }
  };

  const getWeatherDescription = (code) => {
    const descriptions = {
      0: 'Clear sky',
      1: 'Mainly clear',
      2: 'Partly cloudy',
      3: 'Overcast',
      45: 'Foggy',
      48: 'Depositing rime fog',
      51: 'Light drizzle',
      53: 'Moderate drizzle',
      55: 'Dense drizzle',
      61: 'Slight rain',
      63: 'Moderate rain',
      65: 'Heavy rain',
      71: 'Slight snow',
      73: 'Moderate snow',
      75: 'Heavy snow',
      77: 'Snow grains',
      80: 'Slight rain showers',
      81: 'Moderate rain showers',
      82: 'Violent rain showers',
      85: 'Slight snow showers',
      86: 'Heavy snow showers',
      95: 'Thunderstorm',
      96: 'Thunderstorm with slight hail',
      99: 'Thunderstorm with heavy hail',
    };
    return descriptions[code] || 'Unknown';
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">Weather</h2>
          <button onClick={onClose} className="text-black">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4">
          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-cyan-600" />
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <p className="text-red-600">{error}</p>
              <button
                onClick={getLocationAndWeather}
                className="mt-4 px-4 py-2 bg-cyan-600 text-white rounded"
              >
                Retry
              </button>
            </div>
          )}

          {weather && !loading && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-gray-600 text-sm">
                <MapPin className="w-4 h-4" />
                <span>{weather.location}</span>
              </div>

              <div className="text-center">
                <div className="text-6xl font-bold text-black">{weather.temp}°F</div>
                <div className="text-lg text-gray-600 mt-1">{getWeatherDescription(weather.code)}</div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-200">
                <div className="flex items-center gap-2 text-gray-700">
                  <Droplets className="w-5 h-5 text-blue-500" />
                  <div>
                    <div className="text-xs text-gray-500">Humidity</div>
                    <div className="font-bold">{weather.humidity}%</div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-gray-700">
                  <Wind className="w-5 h-5 text-gray-500" />
                  <div>
                    <div className="text-xs text-gray-500">Wind</div>
                    <div className="font-bold">{weather.windSpeed} mph</div>
                  </div>
                </div>
              </div>

              <button
                onClick={getLocationAndWeather}
                className="w-full py-2 bg-gray-100 text-gray-700 font-medium rounded mt-2"
              >
                Refresh
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
