import { useState, useEffect } from 'react';
import { X, Loader2, ChevronRight, Fuel, Save } from 'lucide-react';

export function FleetModal({ show, onClose, identity }) {
  const [step, setStep] = useState('units');
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState(null);
  const [statusOptions, setStatusOptions] = useState([]);
  const [fuelForm, setFuelForm] = useState({ miles: '', gallons: '', cost: '', station: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    if (show) {
      loadUnits();
    }
  }, [show]);

  const loadUnits = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/cad/fleet/units', { credentials: 'include' });
      const data = await response.json();
      if (data.units) {
        setUnits(data.units);
      }
      if (data.statusOptions) {
        setStatusOptions(data.statusOptions);
      }
    } catch (err) {
      setUnits([{ id: identity, name: identity }]);
      setStatusOptions(['In Service', 'Out of Service', 'Available', 'En Route', 'On Scene']);
    } finally {
      setLoading(false);
    }
  };

  const handleUnitSelect = (unit) => {
    setSelectedUnit(unit);
    setStep('details');
  };

  const handleStatusChange = async (newStatus) => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/cad/fleet/unit/${selectedUnit.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ status: newStatus }),
      });
      if (response.ok) {
        setSuccess('Status updated');
        setTimeout(() => setSuccess(null), 2000);
      }
    } catch (err) {
      setError('Failed to update status');
    } finally {
      setSaving(false);
    }
  };

  const handleFuelSubmit = async () => {
    if (!fuelForm.miles || !fuelForm.gallons) {
      setError('Please enter miles and gallons');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/cad/fleet/unit/${selectedUnit.id}/fuel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(fuelForm),
      });
      if (response.ok) {
        setSuccess('Fuel entry saved');
        setFuelForm({ miles: '', gallons: '', cost: '', station: '' });
        setTimeout(() => setSuccess(null), 2000);
      }
    } catch (err) {
      setError('Failed to save fuel entry');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    setStep('units');
    setSelectedUnit(null);
    setFuelForm({ miles: '', gallons: '', cost: '', station: '' });
    setError(null);
    setSuccess(null);
    onClose();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl border-2 border-black w-full max-w-sm flex flex-col max-h-[80vh]">
        <div className="p-4 border-b border-black flex items-center justify-between">
          <h2 className="text-black font-mono font-bold uppercase tracking-wider">
            {step === 'units' ? 'Fleet - Select Unit' : `Unit: ${selectedUnit?.name || selectedUnit?.id}`}
          </h2>
          <button onClick={handleClose} className="text-black">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 space-y-3 overflow-y-auto">
          {loading && (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          )}

          {step === 'units' && !loading && (
            <>
              {units.length === 0 ? (
                <p className="text-center text-gray-500">No units found</p>
              ) : (
                units.map(unit => (
                  <button
                    key={unit.id}
                    onClick={() => handleUnitSelect(unit)}
                    className="w-full p-3 border border-gray-300 rounded flex items-center justify-between text-black hover:bg-gray-50"
                  >
                    <span className="font-bold">{unit.name || unit.id}</span>
                    <ChevronRight className="w-5 h-5 text-gray-400" />
                  </button>
                ))
              )}
            </>
          )}

          {step === 'details' && selectedUnit && (
            <>
              {success && <p className="text-green-600 text-sm text-center font-bold">{success}</p>}
              {error && <p className="text-red-600 text-sm text-center">{error}</p>}

              <div className="border-b border-gray-200 pb-3">
                <p className="text-sm font-bold text-gray-700 mb-2">Status</p>
                <div className="flex flex-wrap gap-2">
                  {statusOptions.map(status => (
                    <button
                      key={status}
                      onClick={() => handleStatusChange(status)}
                      disabled={saving}
                      className="px-3 py-1 text-sm bg-gray-100 border border-gray-300 rounded hover:bg-cyan-100 text-black"
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>

              <div className="pt-2">
                <p className="text-sm font-bold text-gray-700 mb-2 flex items-center gap-1">
                  <Fuel className="w-4 h-4" /> Fuel Entry
                </p>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      placeholder="Miles"
                      value={fuelForm.miles}
                      onChange={(e) => setFuelForm(p => ({ ...p, miles: e.target.value }))}
                      className="p-2 border border-gray-300 rounded text-black"
                    />
                    <input
                      type="number"
                      placeholder="Gallons"
                      value={fuelForm.gallons}
                      onChange={(e) => setFuelForm(p => ({ ...p, gallons: e.target.value }))}
                      className="p-2 border border-gray-300 rounded text-black"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="number"
                      placeholder="Cost $"
                      value={fuelForm.cost}
                      onChange={(e) => setFuelForm(p => ({ ...p, cost: e.target.value }))}
                      className="p-2 border border-gray-300 rounded text-black"
                    />
                    <input
                      type="text"
                      placeholder="Station"
                      value={fuelForm.station}
                      onChange={(e) => setFuelForm(p => ({ ...p, station: e.target.value }))}
                      className="p-2 border border-gray-300 rounded text-black"
                    />
                  </div>
                  <button
                    onClick={handleFuelSubmit}
                    disabled={saving}
                    className="w-full py-2 bg-cyan-600 text-white font-bold uppercase rounded flex items-center justify-center gap-2"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                    Save Fuel Entry
                  </button>
                </div>
              </div>

              <button
                onClick={() => setStep('units')}
                className="w-full py-2 bg-gray-200 text-black font-bold uppercase rounded mt-2"
              >
                Back to Units
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
