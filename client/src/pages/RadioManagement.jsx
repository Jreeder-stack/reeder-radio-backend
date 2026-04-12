import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRadios, assignRadioUnit, lockRadio, getRadioUsers } from '../utils/radiosApi.js';

function formatLastSeen(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const day = String(d.getDate()).padStart(2, '0');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const month = months[d.getMonth()];
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${month} ${year} ${hh}:${mm}`;
}

function Toast({ message, visible }) {
  if (!visible) return null;
  return (
    <div style={{
      position: 'fixed',
      bottom: 32,
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#16a34a',
      color: '#fff',
      padding: '10px 24px',
      borderRadius: 8,
      fontWeight: 600,
      fontSize: 15,
      zIndex: 9999,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      pointerEvents: 'none',
    }}>
      {message}
    </div>
  );
}

function ConfirmDialog({ open, title, message, onConfirm, onCancel }) {
  if (!open) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0,0,0,0.6)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9998,
    }}>
      <div style={{
        background: '#1e1e2e',
        border: '1px solid #333',
        borderRadius: 10,
        padding: '28px 32px',
        minWidth: 340,
        maxWidth: 440,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h3 style={{ margin: '0 0 12px', color: '#fff', fontSize: 17 }}>{title}</h3>
        <p style={{ margin: '0 0 24px', color: '#aaa', fontSize: 14, lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 18px',
              background: '#333',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: '8px 18px',
              background: '#dc2626',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            Lock Radio
          </button>
        </div>
      </div>
    </div>
  );
}

export default function RadioManagement({ user }) {
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';

  const [radios, setRadios] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toastMsg, setToastMsg] = useState('');
  const [toastVisible, setToastVisible] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({ open: false, radioId: null, radioDisplayId: '' });
  const [savingRows, setSavingRows] = useState({});
  const [pendingSelections, setPendingSelections] = useState({});

  const showToast = useCallback((msg) => {
    setToastMsg(msg);
    setToastVisible(true);
    setTimeout(() => setToastVisible(false), 2000);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [radiosData, usersData] = await Promise.all([getRadios(), getRadioUsers()]);
      setRadios(radiosData.radios || []);
      setUsers(usersData.users || []);
    } catch (err) {
      console.error('[RadioManagement] Failed to load:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSubmitAssign = useCallback(async (radioId) => {
    const pendingValue = pendingSelections[radioId];
    if (pendingValue === undefined) return;
    const userId = pendingValue || null;
    setSavingRows(prev => ({ ...prev, [radioId]: true }));
    try {
      const result = await assignRadioUnit(radioId, userId, { force: true });
      const updatedRadio = result.radio;
      if (userId) {
        const assignedUser = users.find(u => String(u.id) === String(userId));
        updatedRadio.assigned_unit_identity = assignedUser?.unit_id || assignedUser?.username || null;
      } else {
        updatedRadio.assigned_unit_identity = null;
      }
      setRadios(prev => prev.map(r => r.radio_id === radioId ? updatedRadio : r));
      setPendingSelections(prev => {
        const next = { ...prev };
        delete next[radioId];
        return next;
      });
      const label = updatedRadio.assigned_unit_identity || (userId ? String(userId) : null);
      showToast(label ? `Assigned — ${label}` : 'Unassigned');
    } catch (err) {
      console.error('[RadioManagement] Assign failed:', err);
    } finally {
      setSavingRows(prev => ({ ...prev, [radioId]: false }));
    }
  }, [showToast, users, pendingSelections]);

  const handleLockClick = useCallback((radio) => {
    if (radio.is_locked) {
      doLock(radio.radio_id, false);
    } else {
      setConfirmDialog({ open: true, radioId: radio.radio_id, radioDisplayId: radio.radio_id });
    }
  }, []);

  const doLock = useCallback(async (radioId, isLocked) => {
    setSavingRows(prev => ({ ...prev, [radioId]: true }));
    try {
      const result = await lockRadio(radioId, isLocked);
      setRadios(prev => prev.map(r => r.radio_id === radioId ? { ...r, ...result.radio } : r));
    } catch (err) {
      console.error('[RadioManagement] Lock failed:', err);
    } finally {
      setSavingRows(prev => ({ ...prev, [radioId]: false }));
    }
  }, []);

  const handleConfirmLock = useCallback(() => {
    const { radioId } = confirmDialog;
    setConfirmDialog({ open: false, radioId: null, radioDisplayId: '' });
    doLock(radioId, true);
  }, [confirmDialog, doLock]);

  const searchLower = search.toLowerCase();
  const filtered = radios.filter(r => {
    if (!search) return true;
    return (
      r.radio_id?.toLowerCase().includes(searchLower) ||
      (r.imei || '').toLowerCase().includes(searchLower) ||
      r.serial_number?.toLowerCase().includes(searchLower) ||
      (r.assigned_unit_identity || '').toLowerCase().includes(searchLower) ||
      formatLastSeen(r.last_seen).toLowerCase().includes(searchLower)
    );
  });

  return (
    <div style={{ minHeight: '100vh', background: '#0f1117', color: '#e2e8f0', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{
        background: '#1a1d2e',
        borderBottom: '1px solid #2d3148',
        padding: '14px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            onClick={() => navigate(-1)}
            style={{
              background: '#2d3148', color: '#94a3b8', border: 'none',
              borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            ← Back
          </button>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#f1f5f9' }}>
            Radio Management
          </h1>
          <span style={{ fontSize: 13, color: '#64748b', fontWeight: 500 }}>
            {radios.length} {radios.length === 1 ? 'device' : 'devices'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>
            {user?.username}
            {isAdmin && <span style={{ marginLeft: 6, color: '#6366f1', fontWeight: 600 }}>Admin</span>}
          </span>
        </div>
      </header>

      <div style={{ padding: '20px 24px' }}>
        <div style={{ marginBottom: 16 }}>
          <input
            type="text"
            placeholder="Search radios..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%',
              maxWidth: 400,
              padding: '9px 14px',
              background: '#1a1d2e',
              border: '1px solid #2d3148',
              borderRadius: 8,
              color: '#e2e8f0',
              fontSize: 14,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#64748b', fontSize: 15 }}>
            Loading radios...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: '#64748b', fontSize: 15 }}>
            {radios.length === 0 ? 'No radios registered yet.' : 'No radios match your search.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2d3148' }}>
                  {['Radio ID', 'IMEI', 'Serial #', 'Assigned Unit', 'Last Seen', 'Lock'].map(col => (
                    <th
                      key={col}
                      style={{
                        padding: '10px 14px',
                        textAlign: 'left',
                        color: '#64748b',
                        fontWeight: 600,
                        fontSize: 12,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(radio => (
                  <tr
                    key={radio.radio_id}
                    style={{
                      borderBottom: '1px solid #1e2235',
                      background: radio.is_locked ? 'rgba(220,38,38,0.05)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '12px 14px', fontFamily: 'monospace', fontWeight: 600, color: '#e2e8f0' }}>
                      {radio.radio_id}
                    </td>
                    <td style={{ padding: '12px 14px', color: '#94a3b8', fontFamily: 'monospace' }}>
                      {radio.imei || '—'}
                    </td>
                    <td style={{ padding: '12px 14px', color: '#94a3b8', fontFamily: 'monospace', fontSize: 13 }}>
                      {radio.serial_number}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      {(() => {
                        const currentVal = String(radio.assigned_unit_id || '');
                        const hasPending = radio.radio_id in pendingSelections;
                        const pendingVal = hasPending ? pendingSelections[radio.radio_id] : currentVal;
                        const hasChange = hasPending;
                        const isSaving = savingRows[radio.radio_id];
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <select
                              value={pendingVal}
                              disabled={isSaving}
                              onChange={e => setPendingSelections(prev => ({ ...prev, [radio.radio_id]: e.target.value }))}
                              style={{
                                background: '#1a1d2e',
                                border: '1px solid #2d3148',
                                borderRadius: 6,
                                color: pendingVal ? '#e2e8f0' : '#64748b',
                                padding: '5px 10px',
                                fontSize: 13,
                                cursor: isSaving ? 'not-allowed' : 'pointer',
                                minWidth: 140,
                                outline: 'none',
                              }}
                            >
                              <option value="">Unassigned</option>
                              {users
                                .filter(u => u.unit_id)
                                .map(u => (
                                  <option key={u.id} value={u.id}>
                                    {u.unit_id}
                                  </option>
                                ))}
                            </select>
                            <button
                              onClick={() => handleSubmitAssign(radio.radio_id)}
                              disabled={!hasChange || isSaving}
                              style={{
                                padding: '5px 12px',
                                fontSize: 12,
                                fontWeight: 600,
                                borderRadius: 6,
                                border: 'none',
                                cursor: (!hasChange || isSaving) ? 'not-allowed' : 'pointer',
                                background: '#4f46e5',
                                color: '#fff',
                                opacity: (!hasChange || isSaving) ? 0.4 : 1,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {isSaving ? 'Saving…' : 'Submit'}
                            </button>
                          </div>
                        );
                      })()}
                    </td>
                    <td style={{ padding: '12px 14px', color: '#64748b', fontSize: 13, whiteSpace: 'nowrap' }}>
                      {formatLastSeen(radio.last_seen)}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      <button
                        onClick={isAdmin ? () => handleLockClick(radio) : undefined}
                        disabled={!isAdmin || savingRows[radio.radio_id]}
                        style={{
                          padding: '5px 12px',
                          fontSize: 12,
                          fontWeight: 600,
                          borderRadius: 6,
                          border: 'none',
                          cursor: (!isAdmin || savingRows[radio.radio_id]) ? 'not-allowed' : 'pointer',
                          background: radio.is_locked ? '#15803d' : '#991b1b',
                          color: '#fff',
                          opacity: (!isAdmin || savingRows[radio.radio_id]) ? 0.4 : 1,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {radio.is_locked ? 'Unlock' : 'Lock'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Toast message={toastMsg} visible={toastVisible} />

      <ConfirmDialog
        open={confirmDialog.open}
        title={`Lock radio ${confirmDialog.radioDisplayId}?`}
        message={`This will immediately disconnect it from the network.`}
        onConfirm={handleConfirmLock}
        onCancel={() => setConfirmDialog({ open: false, radioId: null, radioDisplayId: '' })}
      />
    </div>
  );
}
