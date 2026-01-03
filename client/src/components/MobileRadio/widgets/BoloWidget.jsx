import { useState, useEffect } from 'react';
import { X, Loader2, AlertCircle, RefreshCw } from 'lucide-react';

export function BoloWidget({ show, onClose }) {
  const [bolos, setBolos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (show) {
      fetchBolos();
    }
  }, [show]);

  const fetchBolos = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/cad/bolo/recent', { credentials: 'include' });
      const data = await response.json();
      if (response.ok) {
        setBolos(data.bolos || []);
      } else {
        setError(data.message || 'Failed to fetch BOLOs');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setLoading(false);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">Recent BOLOs</h2>
          <div className="flex items-center gap-2">
            <button onClick={fetchBolos} className="text-gray-500 hover:text-black">
              <RefreshCw className="w-4 h-4" />
            </button>
            <button onClick={onClose} className="text-black">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          )}

          {error && (
            <div className="text-center py-8">
              <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
              <p className="text-red-600">{error}</p>
              <button
                onClick={fetchBolos}
                className="mt-4 px-4 py-2 bg-cyan-600 text-white rounded"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && bolos.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
              <p>No active BOLOs</p>
            </div>
          )}

          {!loading && !error && bolos.length > 0 && (
            <div className="space-y-3">
              {bolos.map((bolo, index) => (
                <div
                  key={bolo.id || index}
                  className="p-3 border border-yellow-400 bg-yellow-50 rounded"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <div className="font-bold text-black text-sm">{bolo.type || 'BOLO'}</div>
                      <p className="text-sm text-gray-800 mt-1">{bolo.description}</p>
                      {bolo.vehicle && (
                        <p className="text-sm text-gray-700 mt-1">
                          <strong>Vehicle:</strong> {bolo.vehicle}
                        </p>
                      )}
                      {bolo.suspect && (
                        <p className="text-sm text-gray-700 mt-1">
                          <strong>Suspect:</strong> {bolo.suspect}
                        </p>
                      )}
                      {bolo.location && (
                        <p className="text-sm text-gray-700 mt-1">
                          <strong>Location:</strong> {bolo.location}
                        </p>
                      )}
                      <p className="text-xs text-gray-500 mt-2">{formatDate(bolo.createdAt)}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
