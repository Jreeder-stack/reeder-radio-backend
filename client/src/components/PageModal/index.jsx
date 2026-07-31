import { useState, useEffect, useCallback } from 'react';

function targetTypeLabel(type) {
  if (type === 'unit') return 'Single Radio';
  if (type === 'units') return 'Selected Radios';
  if (type === 'list') return 'Saved Paging List';
  if (type === 'channel') return 'Channel';
  return 'All Radios';
}

export default function PageModal({ target, onClose }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sentPage, setSentPage] = useState(null);
  const [acks, setAcks] = useState([]);
  const [targetedUnits, setTargetedUnits] = useState([]);

  const pollAcks = useCallback(async (pageId) => {
    try {
      const res = await fetch(`/api/dispatch/page/${pageId}/acks`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setAcks(data.acks || []);
      }
    } catch (err) {
      console.error('[PageModal] Failed to poll acks:', err);
    }
  }, []);

  useEffect(() => {
    if (!sentPage) return undefined;
    const interval = setInterval(() => pollAcks(sentPage.id), 2000);
    return () => clearInterval(interval);
  }, [sentPage, pollAcks]);

  const handleSend = async (e) => {
    e.preventDefault();
    if (!message.trim()) return;
    setSending(true);
    try {
      const body = {
        message: message.trim(),
        targetType: target.type,
        targetId: target.id,
      };
      if (target.type === 'units') body.radioIds = target.radioIds;

      const res = await fetch('/api/dispatch/page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to send page');

      setSentPage(data.page);
      setTargetedUnits(data.targetedUnits || []);
      pollAcks(data.page.id);
    } catch (err) {
      alert('Failed to send page: ' + err.message);
    } finally {
      setSending(false);
    }
  };

  const ackedIds = new Set(acks.map(a => a.radio_id || a.unit_id));

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--dispatch-bg, #1a1a2e)', border: '1px solid var(--dispatch-border, #333)',
          borderRadius: 12, padding: 24, width: '100%', maxWidth: 460,
          maxHeight: '85vh', overflowY: 'auto', boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--dispatch-text, #eee)' }}>
            {sentPage ? 'Page Sent' : `Page ${target.label}`}
          </h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--dispatch-secondary, #888)', cursor: 'pointer', fontSize: 20 }}>✕</button>
        </div>

        {!sentPage ? (
          <form onSubmit={handleSend}>
            <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--dispatch-secondary, #888)' }}>
              Target: <strong style={{ color: 'var(--dispatch-text, #eee)' }}>{target.label}</strong>
              {' '}({targetTypeLabel(target.type)})
            </div>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Type dispatch message..."
              maxLength={200}
              rows={4}
              style={{
                width: '100%', boxSizing: 'border-box', background: 'var(--dispatch-surface, #222)',
                border: '1px solid var(--dispatch-border, #333)', borderRadius: 8, color: '#eee',
                padding: '10px 12px', fontSize: 14, resize: 'vertical', marginBottom: 16, fontFamily: 'inherit',
              }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={onClose} style={{ padding: '8px 16px', borderRadius: 6, border: '1px solid var(--dispatch-border, #333)', background: 'transparent', color: 'var(--dispatch-secondary, #888)', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
              <button type="submit" disabled={sending || !message.trim()} style={{ padding: '8px 20px', borderRadius: 6, border: 'none', background: sending ? '#555' : '#b45309', color: '#fff', cursor: sending || !message.trim() ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 600 }}>
                {sending ? 'Sending...' : 'Send Page'}
              </button>
            </div>
          </form>
        ) : (
          <div>
            <div style={{ padding: '10px 14px', borderRadius: 8, background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', color: '#86efac', fontSize: 13, marginBottom: 16 }}>
              <strong>Page dispatched:</strong> &ldquo;{sentPage.message}&rdquo;
            </div>

            <h4 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--dispatch-text, #eee)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Delivery Confirmation</h4>

            {targetedUnits.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--dispatch-secondary, #888)' }}>No radios were resolved for this page.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {targetedUnits.map(unit => {
                  const acked = ackedIds.has(unit.radioId);
                  const ackRecord = acks.find(a => a.radio_id === unit.radioId);
                  const failed = unit.hasDeliveryToken === false;
                  return (
                    <div key={unit.radioPk || unit.radioId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 7, background: 'var(--dispatch-surface, #222)', border: `1px solid ${acked ? 'rgba(34,197,94,0.4)' : failed ? 'rgba(239,68,68,0.45)' : 'var(--dispatch-border, #333)'}` }}>
                      <span style={{ fontSize: 16 }}>{acked ? '✅' : failed ? '⚠️' : '⏳'}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, color: 'var(--dispatch-text, #eee)', fontWeight: 500 }}>{unit.unitId || unit.radioId}</div>
                        <div style={{ fontSize: 11, color: 'var(--dispatch-secondary, #888)' }}>Radio {unit.radioId}</div>
                        {acked && ackRecord && <div style={{ fontSize: 11, color: '#86efac', marginTop: 2 }}>Received {new Date(ackRecord.acked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>}
                        {!acked && failed && <div style={{ fontSize: 11, color: '#fca5a5', marginTop: 2 }}>Failed — no registered push token</div>}
                        {!acked && !failed && <div style={{ fontSize: 11, color: 'var(--dispatch-secondary, #888)', marginTop: 2 }}>Pending...</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={onClose} style={{ padding: '8px 20px', borderRadius: 6, border: '1px solid var(--dispatch-border, #333)', background: 'transparent', color: 'var(--dispatch-secondary, #888)', cursor: 'pointer', fontSize: 13 }}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
