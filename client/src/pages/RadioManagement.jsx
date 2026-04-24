import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRadios, assignRadioUnit, lockRadio, kioskUnlockRadio, kioskRelockRadio, getRadioUsers } from '../utils/radiosApi.js';
import { useTheme } from '../context/ThemeContext.jsx';

const DEFAULT_KIOSK_UNLOCK_MINUTES = 15;

function formatRemainingMinutes(expiresAt, nowMs) {
  if (!expiresAt) return null;
  const expiresMs = typeof expiresAt === 'number'
    ? expiresAt
    : new Date(expiresAt).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  const remainingMs = expiresMs - nowMs;
  const remainingSec = Math.ceil(remainingMs / 1000);
  if (remainingSec < 60) return `${remainingSec}s`;
  const remainingMin = Math.ceil(remainingSec / 60);
  if (remainingMin < 60) return `${remainingMin}m`;
  const hrs = Math.floor(remainingMin / 60);
  const mins = remainingMin % 60;
  return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
}

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
        background: 'var(--dispatch-panel)',
        border: '1px solid var(--dispatch-border)',
        borderRadius: 10,
        padding: '28px 32px',
        minWidth: 340,
        maxWidth: 440,
        boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
      }}>
        <h3 style={{ margin: '0 0 12px', color: 'var(--dispatch-text)', fontSize: 17 }}>{title}</h3>
        <p style={{ margin: '0 0 24px', color: 'var(--dispatch-text-secondary)', fontSize: 14, lineHeight: 1.5 }}>{message}</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            style={{
              padding: '8px 18px',
              background: 'var(--dispatch-panel-elevated)',
              color: 'var(--dispatch-text)',
              border: '1px solid var(--dispatch-border)',
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
  const { darkMode, toggleDarkMode } = useTheme();
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
  const [kioskDurations, setKioskDurations] = useState({});
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

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

  const handleKioskUnlock = useCallback(async (radioId) => {
    const raw = kioskDurations[radioId];
    const parsed = Number(raw);
    const minutes = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_KIOSK_UNLOCK_MINUTES;
    setSavingRows(prev => ({ ...prev, [radioId]: true }));
    try {
      const result = await kioskUnlockRadio(radioId, minutes);
      const expires = result?.kioskUnlockExpiresAt || (Date.now() + minutes * 60 * 1000);
      setRadios(prev => prev.map(r => r.radio_id === radioId
        ? { ...r, kiosk_unlock_expires_at: new Date(expires).toISOString() }
        : r));
      const sock = result?.delivery?.socket ? 'socket' : null;
      const fcm = result?.delivery?.fcm ? 'FCM' : null;
      const via = [sock, fcm].filter(Boolean).join('+') || 'queued';
      showToast(`Kiosk unlocked ${minutes}m (via ${via})`);
    } catch (err) {
      console.error('[RadioManagement] Kiosk unlock failed:', err);
      showToast(`Unlock failed: ${err.message}`);
    } finally {
      setSavingRows(prev => ({ ...prev, [radioId]: false }));
    }
  }, [kioskDurations, showToast]);

  const handleKioskRelock = useCallback(async (radioId) => {
    setSavingRows(prev => ({ ...prev, [radioId]: true }));
    try {
      const result = await kioskRelockRadio(radioId);
      setRadios(prev => prev.map(r => r.radio_id === radioId
        ? { ...r, kiosk_unlock_expires_at: null }
        : r));
      const sock = result?.delivery?.socket ? 'socket' : null;
      const fcm = result?.delivery?.fcm ? 'FCM' : null;
      const via = [sock, fcm].filter(Boolean).join('+') || 'queued';
      showToast(`Re-locked (via ${via})`);
    } catch (err) {
      console.error('[RadioManagement] Kiosk relock failed:', err);
      showToast(`Re-lock failed: ${err.message}`);
    } finally {
      setSavingRows(prev => ({ ...prev, [radioId]: false }));
    }
  }, [showToast]);

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
    <div className="min-h-screen-safe" style={{ background: 'var(--dispatch-bg)', color: 'var(--dispatch-text)', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      <header style={{
        background: 'var(--dispatch-panel)',
        borderBottom: '1px solid var(--dispatch-border)',
        padding: '14px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <button
            onClick={() => navigate(-1)}
            style={{
              background: 'var(--dispatch-panel-elevated)', color: 'var(--dispatch-text-secondary)',
              border: '1px solid var(--dispatch-border)',
              borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13,
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            ← Back
          </button>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--dispatch-text)' }}>
            Radio Management
          </h1>
          <span style={{ fontSize: 13, color: 'var(--dispatch-text-tertiary)', fontWeight: 500 }}>
            {radios.length} {radios.length === 1 ? 'device' : 'devices'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 13, color: 'var(--dispatch-text-tertiary)' }}>
            {user?.username}
            {isAdmin && <span style={{ marginLeft: 6, color: '#6366f1', fontWeight: 600 }}>Admin</span>}
          </span>
          <button
            onClick={toggleDarkMode}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            style={{
              padding: '6px 10px',
              background: 'transparent',
              color: 'var(--dispatch-text-secondary)',
              border: '1px solid var(--dispatch-border)',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 15,
              lineHeight: 1,
            }}
          >
            {darkMode ? '☀️' : '🌙'}
          </button>
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
              background: 'var(--dispatch-panel)',
              border: '1px solid var(--dispatch-border)',
              borderRadius: 8,
              color: 'var(--dispatch-text)',
              fontSize: 14,
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--dispatch-text-tertiary)', fontSize: 15 }}>
            Loading radios...
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--dispatch-text-tertiary)', fontSize: 15 }}>
            {radios.length === 0 ? 'No radios registered yet.' : 'No radios match your search.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--dispatch-border)' }}>
                  {['Radio ID', 'IMEI', 'Serial #', 'Assigned Unit', 'Last Seen', 'Kiosk', 'Lock'].map(col => (
                    <th
                      key={col}
                      style={{
                        padding: '10px 14px',
                        textAlign: 'left',
                        color: 'var(--dispatch-text-tertiary)',
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
                      borderBottom: '1px solid var(--dispatch-border)',
                      background: radio.is_locked ? 'rgba(220,38,38,0.05)' : 'transparent',
                    }}
                  >
                    <td style={{ padding: '12px 14px', fontFamily: 'monospace', fontWeight: 600, color: 'var(--dispatch-text)' }}>
                      {radio.radio_id}
                    </td>
                    <td style={{ padding: '12px 14px', color: 'var(--dispatch-text-secondary)', fontFamily: 'monospace' }}>
                      {radio.imei || '—'}
                    </td>
                    <td style={{ padding: '12px 14px', color: 'var(--dispatch-text-secondary)', fontFamily: 'monospace', fontSize: 13 }}>
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
                                background: 'var(--dispatch-panel)',
                                border: '1px solid var(--dispatch-border)',
                                borderRadius: 6,
                                color: pendingVal ? 'var(--dispatch-text)' : 'var(--dispatch-text-tertiary)',
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
                    <td style={{ padding: '12px 14px', color: 'var(--dispatch-text-tertiary)', fontSize: 13, whiteSpace: 'nowrap' }}>
                      {formatLastSeen(radio.last_seen)}
                    </td>
                    <td style={{ padding: '12px 14px' }}>
                      {(() => {
                        const remaining = formatRemainingMinutes(radio.kiosk_unlock_expires_at, nowMs);
                        const isSaving = savingRows[radio.radio_id];
                        if (remaining) {
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span title="Kiosk unlocked — auto re-lock in" style={{
                                fontSize: 12, fontWeight: 600, color: '#15803d',
                                background: 'rgba(21,128,61,0.12)', padding: '3px 8px', borderRadius: 4,
                                whiteSpace: 'nowrap',
                              }}>
                                Unlocked · {remaining}
                              </span>
                              <button
                                onClick={() => handleKioskRelock(radio.radio_id)}
                                disabled={isSaving}
                                style={{
                                  padding: '5px 10px', fontSize: 12, fontWeight: 600,
                                  borderRadius: 6, border: 'none',
                                  cursor: isSaving ? 'not-allowed' : 'pointer',
                                  background: '#b45309', color: '#fff',
                                  opacity: isSaving ? 0.4 : 1, whiteSpace: 'nowrap',
                                }}
                              >
                                {isSaving ? 'Saving…' : 'Re-lock'}
                              </button>
                            </div>
                          );
                        }
                        const durationVal = kioskDurations[radio.radio_id] ?? '';
                        return (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="number"
                              min={1}
                              max={240}
                              placeholder={String(DEFAULT_KIOSK_UNLOCK_MINUTES)}
                              value={durationVal}
                              disabled={isSaving}
                              onChange={e => setKioskDurations(prev => ({ ...prev, [radio.radio_id]: e.target.value }))}
                              title="Unlock duration in minutes (default 15)"
                              style={{
                                width: 56, padding: '5px 8px',
                                background: 'var(--dispatch-panel)', border: '1px solid var(--dispatch-border)',
                                borderRadius: 6, color: 'var(--dispatch-text)', fontSize: 13, outline: 'none',
                              }}
                            />
                            <span style={{ fontSize: 11, color: 'var(--dispatch-text-tertiary)' }}>min</span>
                            <button
                              onClick={() => handleKioskUnlock(radio.radio_id)}
                              disabled={isSaving}
                              style={{
                                padding: '5px 10px', fontSize: 12, fontWeight: 600,
                                borderRadius: 6, border: 'none',
                                cursor: isSaving ? 'not-allowed' : 'pointer',
                                background: '#0369a1', color: '#fff',
                                opacity: isSaving ? 0.4 : 1, whiteSpace: 'nowrap',
                              }}
                            >
                              {isSaving ? 'Saving…' : 'Unlock kiosk'}
                            </button>
                          </div>
                        );
                      })()}
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
