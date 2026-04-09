import { useState, useEffect, useRef } from 'react';
import { useAudioConnection } from '../context/AudioConnectionContext.jsx';

export default function ConnectionIndicator() {
  const { connectionHealth, connectionStatus, retryConnection } = useAudioConnection();
  const [showRecovered, setShowRecovered] = useState(false);
  const prevStatusRef = useRef(connectionStatus);

  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = connectionStatus;

    if (prev === 'reconnecting' && connectionStatus === 'connected') {
      setShowRecovered(true);
      const timer = setTimeout(() => setShowRecovered(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [connectionStatus]);

  const isReconnecting = connectionStatus === 'reconnecting';
  const isDisconnected = connectionHealth.status === 'disconnected' && !isReconnecting;
  const isFailed = connectionStatus === 'failed';

  const getStatusColor = () => {
    if (showRecovered) return 'bg-green-500';
    if (isReconnecting) return 'bg-yellow-500';
    if (isFailed || isDisconnected) return 'bg-red-500';

    switch (connectionHealth.status) {
      case 'connected':
        return 'bg-green-500';
      case 'partial':
        return 'bg-yellow-500';
      case 'disconnected':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  const getStatusText = () => {
    if (showRecovered) return 'Recovered';
    if (isReconnecting) return 'Reconnecting...';
    if (isFailed) return 'Connection Failed';

    if (connectionHealth.total === 0) return 'No Channels';

    switch (connectionHealth.status) {
      case 'connected':
        return `Connected (${connectionHealth.healthy}/${connectionHealth.total})`;
      case 'partial':
        return `Partial (${connectionHealth.healthy}/${connectionHealth.total})`;
      case 'disconnected':
        return 'Disconnected';
      default:
        return 'Unknown';
    }
  };

  const shouldPulse = isReconnecting || connectionHealth.status === 'partial';
  const showRetry = (isDisconnected || isFailed) && !isReconnecting;

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded bg-dispatch-surface">
      <div className={`w-2.5 h-2.5 rounded-full ${getStatusColor()} ${
        shouldPulse ? 'animate-pulse' : ''
      }`} />
      <span className="text-xs text-dispatch-secondary whitespace-nowrap">
        {getStatusText()}
      </span>
      {showRetry && (
        <button
          onClick={retryConnection}
          className="text-xs text-blue-400 hover:text-blue-300 underline whitespace-nowrap ml-1"
        >
          Retry
        </button>
      )}
    </div>
  );
}
