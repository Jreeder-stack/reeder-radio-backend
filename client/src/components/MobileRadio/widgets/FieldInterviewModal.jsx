import { useState } from 'react';
import { X, Save, Loader2 } from 'lucide-react';

export function FieldInterviewModal({ show, onClose }) {
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    dob: '',
    location: '',
    description: '',
    notes: '',
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async () => {
    if (!form.firstName && !form.lastName) {
      setError('Please enter at least a name');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/cad/fi/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (response.ok) {
        setSuccess(true);
        setTimeout(() => {
          handleClose();
        }, 1500);
      } else {
        setError(data.message || 'Failed to save FI');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setForm({ firstName: '', lastName: '', dob: '', location: '', description: '', notes: '' });
    setSuccess(false);
    setError(null);
    onClose();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">Field Interview</h2>
          <button onClick={handleClose} className="text-black">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          {success ? (
            <div className="py-8 text-center">
              <p className="text-green-600 font-bold text-lg">FI Saved!</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="text"
                  placeholder="First Name"
                  value={form.firstName}
                  onChange={(e) => setForm(p => ({ ...p, firstName: e.target.value }))}
                  className="p-2 border border-gray-300 rounded text-black"
                />
                <input
                  type="text"
                  placeholder="Last Name"
                  value={form.lastName}
                  onChange={(e) => setForm(p => ({ ...p, lastName: e.target.value }))}
                  className="p-2 border border-gray-300 rounded text-black"
                />
              </div>
              <input
                type="text"
                placeholder="DOB (MM/DD/YYYY)"
                value={form.dob}
                onChange={(e) => setForm(p => ({ ...p, dob: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <input
                type="text"
                placeholder="Location"
                value={form.location}
                onChange={(e) => setForm(p => ({ ...p, location: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <input
                type="text"
                placeholder="Description (clothing, hair, etc)"
                value={form.description}
                onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black"
              />
              <textarea
                placeholder="Notes"
                value={form.notes}
                onChange={(e) => setForm(p => ({ ...p, notes: e.target.value }))}
                className="w-full p-2 border border-gray-300 rounded text-black h-20 resize-none"
              />
              {error && <p className="text-red-600 text-sm">{error}</p>}
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="w-full py-2 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save FI
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
