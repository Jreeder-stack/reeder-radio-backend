import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const blank = { name: '', channelId: '', dispatchCenterId: '', agencyId: '', enabled: true, statusChecksEnabled: true };

export default function AIDispatcherProfiles() {
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState([]);
  const [channels, setChannels] = useState([]);
  const [centers, setCenters] = useState([]);
  const [form, setForm] = useState(blank);
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selectedCenter = useMemo(() => centers.find((center) => String(center.id) === String(form.dispatchCenterId)), [centers, form.dispatchCenterId]);

  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'include', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  async function load() {
    setLoading(true); setError('');
    try {
      const [profileData, catalog] = await Promise.all([
        request('/api/admin/ai-dispatchers'),
        request('/api/admin/ai-dispatchers/catalog'),
      ]);
      setProfiles(profileData.profiles || []);
      setChannels(catalog.channels || []);
      setCenters(catalog.dispatchCenters || []);
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  function edit(profile) {
    setEditingId(profile.id);
    setForm({
      name: profile.name || '', channelId: String(profile.channelId || ''), dispatchCenterId: profile.dispatchCenterId || '', agencyId: profile.agencyId || '',
      enabled: !!profile.enabled, statusChecksEnabled: profile.statusChecksEnabled !== false,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() { setEditingId(null); setForm(blank); setError(''); }

  async function save(event) {
    event.preventDefault(); setBusy('save'); setError(''); setNotice('');
    try {
      const url = editingId ? `/api/admin/ai-dispatchers/${editingId}` : '/api/admin/ai-dispatchers';
      await request(url, { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(form) });
      setNotice(editingId ? 'AI dispatcher profile updated.' : 'AI dispatcher profile created.');
      reset(); await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function action(profile, actionName) {
    if (actionName === 'delete' && !window.confirm(`Delete ${profile.name}?`)) return;
    setBusy(`${actionName}-${profile.id}`); setError(''); setNotice('');
    try {
      if (actionName === 'delete') await request(`/api/admin/ai-dispatchers/${profile.id}`, { method: 'DELETE' });
      else await request(`/api/admin/ai-dispatchers/${profile.id}/${actionName}`, { method: 'POST' });
      setNotice(`${profile.name}: ${actionName} complete.`); await load();
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  const panel = { background: 'var(--dispatch-panel)', border: '1px solid var(--dispatch-border)', borderRadius: 12, padding: 18, marginBottom: 18 };
  const input = { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--dispatch-border)', background: 'var(--dispatch-bg)', color: 'var(--dispatch-text)' };
  const button = { border: '1px solid var(--dispatch-border)', borderRadius: 8, padding: '9px 12px', background: 'var(--dispatch-panel)', color: 'var(--dispatch-text)', cursor: 'pointer', fontWeight: 700 };

  return <div style={{ minHeight: '100vh', background: 'var(--dispatch-bg)', color: 'var(--dispatch-text)', padding: 24 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 20 }}>
      <div><h1 style={{ margin: 0 }}>AI Dispatcher Profiles</h1><p style={{ color: 'var(--dispatch-muted)', marginBottom: 0 }}>Each profile is isolated to one Command Link dispatch center and one radio channel.</p></div>
      <button style={button} onClick={() => navigate('/admin')}>Back to Admin</button>
    </div>
    {error && <div style={{ ...panel, borderColor: '#ef4444', color: '#ef4444' }}>{error}</div>}
    {notice && <div style={{ ...panel, borderColor: '#22c55e', color: '#22c55e' }}>{notice}</div>}

    <form onSubmit={save} style={panel}>
      <h2 style={{ marginTop: 0 }}>{editingId ? 'Edit Dispatcher' : 'Add Dispatcher'}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 14 }}>
        <label>Name<input style={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Security AI Dispatcher" required /></label>
        <label>Radio channel<select style={input} value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })} required><option value="">Select channel</option>{channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.zone || 'Default'} — {channel.name}</option>)}</select></label>
        <label>Dispatch center<select style={input} value={form.dispatchCenterId} onChange={(e) => setForm({ ...form, dispatchCenterId: e.target.value, agencyId: '' })} required><option value="">Select center</option>{centers.map((center) => <option key={center.id} value={center.id}>{center.name} ({center.code})</option>)}</select></label>
        <label>Agency<select style={input} value={form.agencyId} onChange={(e) => setForm({ ...form, agencyId: e.target.value })}><option value="">Center default</option>{(selectedCenter?.agencies || []).map((agency) => <option key={agency.id} value={agency.id}>{agency.name} ({agency.code})</option>)}</select></label>
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 16, flexWrap: 'wrap' }}>
        <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
        <label><input type="checkbox" checked={form.statusChecksEnabled} onChange={(e) => setForm({ ...form, statusChecksEnabled: e.target.checked })} /> AI status checks</label>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}><button style={button} disabled={!!busy}>{busy === 'save' ? 'Saving…' : editingId ? 'Save Changes' : 'Create Dispatcher'}</button>{editingId && <button type="button" style={button} onClick={reset}>Cancel</button>}</div>
    </form>

    <div style={panel}>
      <h2 style={{ marginTop: 0 }}>Configured Dispatchers</h2>
      {loading ? <p>Loading…</p> : profiles.length === 0 ? <p>No profiles configured.</p> : <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr>{['Name','Center','Channel','Identity','Runtime','Actions'].map((heading) => <th key={heading} style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid var(--dispatch-border)' }}>{heading}</th>)}</tr></thead><tbody>{profiles.map((profile) => <tr key={profile.id}><td style={{ padding: 10 }}><strong>{profile.name}</strong><div style={{ fontSize: 12, color: 'var(--dispatch-muted)' }}>{profile.enabled ? 'Enabled' : 'Disabled'} · checks {profile.statusChecksEnabled ? 'on' : 'off'}</div>{profile.lastError && <div style={{ fontSize: 12, color: '#ef4444' }}>{profile.lastError}</div>}</td><td style={{ padding: 10 }}>{profile.dispatchCenterName || profile.dispatchCenterId}<div style={{ fontSize: 12 }}>{profile.dispatchCenterCode || ''}</div></td><td style={{ padding: 10 }}>{profile.channelName}<div style={{ fontSize: 12 }}>{profile.roomKey}</div></td><td style={{ padding: 10, fontFamily: 'monospace', fontSize: 12 }}>{profile.identity}</td><td style={{ padding: 10 }}>{profile.runtime?.state || 'unknown'}<div style={{ fontSize: 12 }}>{profile.runtime?.pipeline?.pipelineStatus || ''}</div></td><td style={{ padding: 10 }}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button style={button} onClick={() => edit(profile)}>Edit</button>{profile.enabled ? <button style={button} disabled={!!busy} onClick={() => action(profile, 'stop')}>Stop</button> : <button style={button} disabled={!!busy} onClick={() => action(profile, 'start')}>Start</button>}<button style={button} disabled={!!busy} onClick={() => action(profile, 'restart')}>Restart</button><button style={{ ...button, color: '#ef4444' }} disabled={!!busy} onClick={() => action(profile, 'delete')}>Delete</button></div></td></tr>)}</tbody></table></div>}
    </div>
  </div>;
}
