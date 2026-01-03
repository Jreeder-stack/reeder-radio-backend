import { useState, useEffect } from 'react';
import { X, Send, Loader2 } from 'lucide-react';

export function NewMessageModal({ show, onClose, onMessageSent }) {
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedUnit, setSelectedUnit] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (show) {
      setLoading(true);
      setError(null);
      fetch('/api/cad/contacts', { credentials: 'include' })
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) {
            throw new Error(data.message || 'Failed to load contacts');
          }
          return data;
        })
        .then(data => {
          setUnits(data.contacts || []);
          setLoading(false);
        })
        .catch((err) => {
          setError(err.message || 'Failed to load contacts');
          setLoading(false);
        });
    }
  }, [show]);

  const handleSend = async () => {
    if (!selectedUnit) {
      setError('Please select a recipient');
      return;
    }
    if (!message.trim()) {
      setError('Please enter a message');
      return;
    }

    setSending(true);
    setError(null);

    try {
      const response = await fetch('/api/cad/chats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          recipientId: selectedUnit,
          message: message.trim()
        })
      });

      const data = await response.json();

      if (response.ok) {
        if (onMessageSent) onMessageSent();
        handleClose();
      } else {
        setError(data.message || 'Failed to send message');
      }
    } catch (err) {
      setError('Failed to connect to CAD');
    } finally {
      setSending(false);
    }
  };

  const handleClose = () => {
    setSelectedUnit('');
    setMessage('');
    setError(null);
    onClose();
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl w-full max-w-sm flex flex-col">
        <div className="p-4 border-b border-gray-200 flex items-center justify-between bg-cyan-600 rounded-t-xl">
          <h2 className="text-white font-bold text-lg">New Message</h2>
          <button onClick={handleClose} className="text-white">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {loading ? (
            <div className="py-8 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-cyan-600" />
            </div>
          ) : (
            <>
              <div>
                <label className="text-xs text-gray-500 uppercase font-medium block mb-1">
                  Select Recipient
                </label>
                <select
                  value={selectedUnit}
                  onChange={(e) => setSelectedUnit(e.target.value)}
                  className="w-full p-3 border border-gray-300 rounded text-black bg-white"
                >
                  <option value="">Choose a unit...</option>
                  {units.map(unit => (
                    <option key={unit.id || unit} value={unit.id || unit}>
                      {unit.name || unit.id || unit}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-gray-500 uppercase font-medium block mb-1">
                  Message
                </label>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  placeholder="Type your message..."
                  className="w-full p-3 border border-gray-300 rounded text-black bg-white h-24 resize-none"
                />
              </div>

              {error && (
                <p className="text-red-600 text-sm">{error}</p>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleClose}
                  className="flex-1 py-3 bg-gray-200 text-gray-700 font-bold rounded"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending}
                  className="flex-1 py-3 bg-cyan-600 text-white font-bold rounded flex items-center justify-center gap-2"
                >
                  {sending ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
