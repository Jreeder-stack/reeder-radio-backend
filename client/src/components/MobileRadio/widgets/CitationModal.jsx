import { useState } from 'react';
import { X, AlertTriangle, FileText, Loader2 } from 'lucide-react';

export function CitationModal({ show, onClose }) {
  const [step, setStep] = useState('select');
  const [type, setType] = useState(null);
  const [loading, setLoading] = useState(false);
  const [citation, setCitation] = useState(null);
  const [error, setError] = useState(null);

  const handleTypeSelect = async (selectedType) => {
    setType(selectedType);
    setStep('populate');
  };

  const handlePopulate = async (source) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/cad/citation/new`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ type, populateFrom: source }),
      });
      const data = await response.json();
      if (response.ok) {
        setCitation(data);
        setStep('view');
      } else {
        setError(data.message || 'Failed to create citation');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setStep('select');
    setType(null);
    setCitation(null);
    setError(null);
    onClose();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">
            {step === 'select' ? 'Citation Type' : step === 'populate' ? `New ${type}` : 'Citation'}
          </h2>
          <button onClick={handleClose} className="text-black">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {step === 'select' && (
            <>
              <button
                onClick={() => handleTypeSelect('Warning')}
                className="w-full py-4 bg-yellow-100 border-2 border-yellow-500 text-yellow-800 font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                <AlertTriangle className="w-5 h-5" />
                Warning
              </button>
              <button
                onClick={() => handleTypeSelect('Citation')}
                className="w-full py-4 bg-red-100 border-2 border-red-500 text-red-800 font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                <FileText className="w-5 h-5" />
                Citation
              </button>
            </>
          )}

          {step === 'populate' && (
            <>
              <p className="text-center text-gray-600">Populate {type} data from:</p>
              <button
                onClick={() => handlePopulate('call')}
                disabled={loading}
                className="w-full py-3 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Active Call
              </button>
              <button
                onClick={() => handlePopulate('lastQuery')}
                disabled={loading}
                className="w-full py-3 bg-gray-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Last Query
              </button>
              <button
                onClick={() => handlePopulate('blank')}
                disabled={loading}
                className="w-full py-3 bg-white border border-gray-300 text-black font-bold uppercase rounded"
              >
                Start Blank
              </button>
              {error && <p className="text-red-600 text-sm text-center">{error}</p>}
            </>
          )}

          {step === 'view' && citation && (
            <div className="space-y-3">
              <div className="p-3 bg-gray-100 rounded text-sm text-black">
                <p><strong>Type:</strong> {citation.type}</p>
                <p><strong>Number:</strong> {citation.number || 'Pending'}</p>
                {citation.defendant && <p><strong>Defendant:</strong> {citation.defendant}</p>}
                {citation.vehicle && <p><strong>Vehicle:</strong> {citation.vehicle}</p>}
              </div>
              <p className="text-center text-gray-500 text-sm">
                Citation created. Complete in CAD.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
