import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import useDispatchStore from '../../state/dispatchStore.js';
import ConnectionIndicator from '../ConnectionIndicator.jsx';

export default function TopBar({ user, onLogout, agencyName = "Reeder Radio", darkMode, onToggleTheme }) {
  const navigate = useNavigate();
  const [time, setTime] = useState(new Date());
  const { dispatcherName, isTalking } = useDispatchStore();

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-dispatch-panel border-b border-dispatch-border">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-bold text-dispatch-text">{agencyName}</h1>
        <span className="text-dispatch-secondary">|</span>
        <span className="text-sm text-dispatch-secondary">Dispatch Console</span>
      </div>

      <div className="flex items-center gap-6">
        <ConnectionIndicator />

        {isTalking && (
          <div className="flex items-center gap-2 px-3 py-1 bg-red-600 rounded animate-pulse">
            <span className="text-sm font-bold text-white">TX</span>
          </div>
        )}

        <div className="text-xl font-mono text-dispatch-text">
          {time.toLocaleTimeString()}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-dispatch-secondary">Dispatcher:</span>
          <span className="text-sm font-medium text-dispatch-text">{dispatcherName || user?.username}</span>
        </div>

        <div className="flex items-center gap-2">
          {onToggleTheme && (
            <button
              onClick={onToggleTheme}
              className="px-3 py-1.5 text-sm bg-dispatch-border hover:bg-dispatch-panel text-dispatch-text rounded transition-colors"
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            >
              {darkMode ? "☀️" : "🌙"}
            </button>
          )}
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
            className="px-3 py-1.5 text-sm bg-dispatch-border hover:bg-dispatch-panel text-dispatch-text rounded transition-colors"
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
