import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useDispatchStore from '../../state/dispatchStore.js';

export default function TopBar({ user, onLogout, agencyName = "Reeder Radio" }) {
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());
  const { dispatcherName, isTalking, isConnected } = useDispatchStore();

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-dispatch-panel border-b border-dispatch-border">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold text-white">{agencyName}</h1>
        <span className="text-gray-400">|</span>
        <span className="text-sm text-gray-300">Dispatch Console</span>
      </div>

      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
          <span className="text-sm text-gray-300">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {isTalking && (
          <div className="flex items-center gap-2 px-3 py-1 bg-red-600 rounded animate-pulse">
            <span className="text-sm font-bold text-white">TX</span>
          </div>
        )}

        <div className="text-xl font-mono text-white">
          {time.toLocaleTimeString()}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400">Dispatcher:</span>
          <span className="text-sm font-medium text-white">{dispatcherName || user?.username}</span>
        </div>

        <div className="flex items-center gap-2">
          {user?.role === 'admin' && (
            <button
              onClick={() => navigate('/admin')}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 rounded transition-colors"
            >
              Admin
            </button>
          )}
          <button
            onClick={() => navigate('/')}
            className="px-3 py-1.5 text-sm bg-gray-600 hover:bg-gray-700 rounded transition-colors"
          >
            Radio
          </button>
          <button
            onClick={onLogout}
            className="px-3 py-1.5 text-sm bg-red-600 hover:bg-red-700 rounded transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
