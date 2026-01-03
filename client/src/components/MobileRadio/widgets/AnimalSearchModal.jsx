import { useState, useEffect } from 'react';
import { X, Search, Loader2 } from 'lucide-react';

export function AnimalSearchModal({ show, onClose }) {
  const [animalTypes, setAnimalTypes] = useState([]);
  const [form, setForm] = useState({
    tag: '',
    ownerLast: '',
    ownerFirst: '',
    microchip: '',
    name: '',
    animalType: '',
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (show) {
      fetch('/api/cad/animal/types', { credentials: 'include' })
        .then(res => res.json())
        .then(data => {
          if (data.types) setAnimalTypes(data.types);
        })
        .catch(() => {
          setAnimalTypes(['Dog', 'Cat', 'Horse', 'Bird', 'Other']);
        });
    }
  }, [show]);

  const handleSearch = async () => {
    if (!form.tag && !form.ownerLast && !form.ownerFirst && !form.microchip && !form.name) {
      setError('Please enter at least one search field');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch('/api/cad/animal/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(form),
      });
      const data = await response.json();
      if (response.ok) {
        setResult(data);
      } else {
        setError(data.message || 'Search failed');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setForm({ tag: '', ownerLast: '', ownerFirst: '', microchip: '', name: '', animalType: '' });
    setResult(null);
    setError(null);
    onClose();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">Animal Search</h2>
          <button onClick={handleClose} className="text-black">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          <input
            type="text"
            placeholder="Tag Number"
            value={form.tag}
            onChange={(e) => setForm(p => ({ ...p, tag: e.target.value }))}
            className="w-full p-2 border border-gray-300 rounded text-black"
          />
          <input
            type="text"
            placeholder="Owner Last Name"
            value={form.ownerLast}
            onChange={(e) => setForm(p => ({ ...p, ownerLast: e.target.value }))}
            className="w-full p-2 border border-gray-300 rounded text-black"
          />
          <input
            type="text"
            placeholder="Owner First Name"
            value={form.ownerFirst}
            onChange={(e) => setForm(p => ({ ...p, ownerFirst: e.target.value }))}
            className="w-full p-2 border border-gray-300 rounded text-black"
          />
          <input
            type="text"
            placeholder="Microchip Number"
            value={form.microchip}
            onChange={(e) => setForm(p => ({ ...p, microchip: e.target.value }))}
            className="w-full p-2 border border-gray-300 rounded text-black"
          />
          <input
            type="text"
            placeholder="Animal Name"
            value={form.name}
            onChange={(e) => setForm(p => ({ ...p, name: e.target.value }))}
            className="w-full p-2 border border-gray-300 rounded text-black"
          />
          <select
            value={form.animalType}
            onChange={(e) => setForm(p => ({ ...p, animalType: e.target.value }))}
            className="w-full p-2 border border-gray-300 rounded text-black bg-white"
          >
            <option value="">All Types</option>
            {animalTypes.map(type => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          {result && (
            <div className="p-3 bg-gray-100 rounded text-sm text-black max-h-48 overflow-y-auto">
              <pre className="whitespace-pre-wrap">{JSON.stringify(result, null, 2)}</pre>
            </div>
          )}
          <button
            onClick={handleSearch}
            disabled={loading}
            className="w-full py-2 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
            Search
          </button>
        </div>
      </div>
    </div>
  );
}
