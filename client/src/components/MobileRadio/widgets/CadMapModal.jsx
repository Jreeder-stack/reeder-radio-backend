import { X, ExternalLink } from 'lucide-react';

export function CadMapModal({ show, onClose }) {
  const handleOpenMap = () => {
    window.open('/api/cad/map/redirect', '_blank');
    onClose();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">CAD Map</h2>
          <button onClick={onClose} className="text-black">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-4">
          <p className="text-center text-gray-600">
            Open the CAD map in a new window to view active calls and unit locations.
          </p>
          <button
            onClick={handleOpenMap}
            className="w-full py-3 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
          >
            <ExternalLink className="w-5 h-5" />
            Open CAD Map
          </button>
        </div>
      </div>
    </div>
  );
}
