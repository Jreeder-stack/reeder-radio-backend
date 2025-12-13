import { useLiveKitConnection } from '../context/LiveKitConnectionContext.jsx';

export default function ConnectionIndicator() {
  const { connectionHealth } = useLiveKitConnection();
  
  const getStatusColor = () => {
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

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded bg-dispatch-surface">
      <div className={`w-2.5 h-2.5 rounded-full ${getStatusColor()} ${
        connectionHealth.status === 'partial' ? 'animate-pulse' : ''
      }`} />
      <span className="text-xs text-dispatch-secondary whitespace-nowrap">
        {getStatusText()}
      </span>
    </div>
  );
}
