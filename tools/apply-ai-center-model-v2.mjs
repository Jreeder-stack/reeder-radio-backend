import fs from 'fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
  console.log(`[patch] updated ${path}`);
}

function replaceExact(content, search, replacement, label) {
  if (!content.includes(search)) {
    throw new Error(`Missing expected text for ${label}`);
  }
  return content.replace(search, replacement);
}

function replaceRegex(content, regex, replacement, label) {
  if (!regex.test(content)) {
    throw new Error(`Missing expected pattern for ${label}`);
  }
  return content.replace(regex, replacement);
}

// Remove the obsolete manual user/radio-to-dispatch-center workflow from the client shell.
{
  const path = 'client/src/main.jsx';
  let content = read(path);
  content = replaceExact(
    content,
    'import DispatchCenterAssignments from "./pages/DispatchCenterAssignments.jsx";\n',
    '',
    'DispatchCenterAssignments import',
  );
  content = replaceExact(
    content,
    "          bottom: 72,",
    "          bottom: 20,",
    'AI dispatcher button position',
  );
  content = replaceExact(
    content,
    '        AI Dispatcher Profiles',
    '        AI Dispatchers',
    'AI dispatcher button label',
  );
  content = replaceRegex(
    content,
    /\n      <button\n        type="button"\n        onClick=\{\(\) => window\.location\.assign\('\/admin\/dispatch-centers'\)\}[\s\S]*?\n      <\/button>/,
    '',
    'manual dispatch-center assignment button',
  );
  content = replaceRegex(
    content,
    /\n            <Route\n              path="\/admin\/dispatch-centers"[\s\S]*?\n            \/>/,
    '',
    'manual dispatch-center assignment route',
  );
  write(path, content);
}

// Remove the obsolete manual assignment API from route registration.
{
  const path = 'src/routes/index.js';
  let content = read(path);
  content = replaceExact(
    content,
    "import dispatchCenterAssignmentsRouter from './dispatchCenterAssignmentsRouter.js';\n",
    '',
    'manual assignment router import',
  );
  content = replaceExact(
    content,
    "  app.use('/api/admin/dispatch-center-assignments', dispatchCenterAssignmentsRouter);\n",
    '',
    'manual assignment router mount',
  );
  write(path, content);
}

for (const path of [
  'client/src/pages/DispatchCenterAssignments.jsx',
  'src/routes/dispatchCenterAssignmentsRouter.js',
]) {
  if (fs.existsSync(path)) {
    fs.unlinkSync(path);
    console.log(`[patch] removed ${path}`);
  }
}

// Profiles now bind only a radio channel to a Command Link dispatch center.
{
  const path = 'client/src/pages/AIDispatcherProfiles.jsx';
  const content = `import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

const blank = {
  name: '',
  channelId: '',
  dispatchCenterId: '',
  enabled: true,
  statusChecksEnabled: true,
};

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

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || \\`Request failed (\\${response.status})\\`);
    return body;
  }

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [profileData, catalog] = await Promise.all([
        request('/api/admin/ai-dispatchers'),
        request('/api/admin/ai-dispatchers/catalog'),
      ]);
      setProfiles(profileData.profiles || []);
      setChannels(catalog.channels || []);
      setCenters(catalog.dispatchCenters || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  function edit(profile) {
    setEditingId(profile.id);
    setForm({
      name: profile.name || '',
      channelId: String(profile.channelId || ''),
      dispatchCenterId: profile.dispatchCenterId || '',
      enabled: !!profile.enabled,
      statusChecksEnabled: profile.statusChecksEnabled !== false,
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function reset() {
    setEditingId(null);
    setForm(blank);
    setError('');
  }

  async function save(event) {
    event.preventDefault();
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const url = editingId
        ? \\`/api/admin/ai-dispatchers/\\${editingId}\\`
        : '/api/admin/ai-dispatchers';
      await request(url, {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(form),
      });
      setNotice(editingId ? 'AI dispatcher updated.' : 'AI dispatcher created.');
      reset();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function action(profile, actionName) {
    if (actionName === 'delete' && !window.confirm(\\`Delete \\${profile.name}?\\`)) return;
    setBusy(\\`\\${actionName}-\\${profile.id}\\`);
    setError('');
    setNotice('');
    try {
      if (actionName === 'delete') {
        await request(\\`/api/admin/ai-dispatchers/\\${profile.id}\\`, { method: 'DELETE' });
      } else {
        await request(\\`/api/admin/ai-dispatchers/\\${profile.id}/\\${actionName}\\`, { method: 'POST' });
      }
      setNotice(\\`\\${profile.name}: \\${actionName} complete.\\`);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  const panel = {
    background: 'var(--dispatch-panel)',
    border: '1px solid var(--dispatch-border)',
    borderRadius: 12,
    padding: 18,
    marginBottom: 18,
  };
  const input = {
    width: '100%',
    padding: '10px 12px',
    borderRadius: 8,
    border: '1px solid var(--dispatch-border)',
    background: 'var(--dispatch-bg)',
    color: 'var(--dispatch-text)',
  };
  const button = {
    border: '1px solid var(--dispatch-border)',
    borderRadius: 8,
    padding: '9px 12px',
    background: 'var(--dispatch-panel)',
    color: 'var(--dispatch-text)',
    cursor: 'pointer',
    fontWeight: 700,
  };

  return <div style={{ minHeight: '100vh', background: 'var(--dispatch-bg)', color: 'var(--dispatch-text)', padding: 24 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 20 }}>
      <div>
        <h1 style={{ margin: 0 }}>AI Dispatchers</h1>
        <p style={{ color: 'var(--dispatch-muted)', marginBottom: 0 }}>
          Choose one radio channel and the Command Link dispatch center this AI controls.
        </p>
      </div>
      <button style={button} onClick={() => navigate('/admin')}>Back to Admin</button>
    </div>

    <div style={{ ...panel, borderColor: 'var(--dispatch-accent)' }}>
      <strong>Automatic unit ownership</strong>
      <div style={{ color: 'var(--dispatch-muted)', marginTop: 6, lineHeight: 1.5 }}>
        Units already belong to an agency, and the agency already belongs to a dispatch center. No separate radio-user assignment is required. The AI can speak with any unit on its channel, but it can only change records inside the selected CAD.
      </div>
    </div>

    {error && <div style={{ ...panel, borderColor: '#ef4444', color: '#ef4444' }}>{error}</div>}
    {notice && <div style={{ ...panel, borderColor: '#22c55e', color: '#22c55e' }}>{notice}</div>}

    <form onSubmit={save} style={panel}>
      <h2 style={{ marginTop: 0 }}>{editingId ? 'Edit AI Dispatcher' : 'Create AI Dispatcher'}</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 14 }}>
        <label>
          Dispatcher name
          <input
            style={input}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Security AI Dispatcher"
            required
          />
        </label>
        <label>
          Radio channel
          <select
            style={input}
            value={form.channelId}
            onChange={(e) => setForm({ ...form, channelId: e.target.value })}
            required
          >
            <option value="">Select channel</option>
            {channels.map((channel) => (
              <option key={channel.id} value={channel.id}>
                {channel.zone || 'Default'} — {channel.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Command Link dispatch center
          <select
            style={input}
            value={form.dispatchCenterId}
            onChange={(e) => setForm({ ...form, dispatchCenterId: e.target.value })}
            required
          >
            <option value="">Select dispatch center</option>
            {centers.map((center) => (
              <option key={center.id} value={center.id}>
                {center.name} ({center.code})
              </option>
            ))}
          </select>
        </label>
      </div>
      <div style={{ display: 'flex', gap: 18, marginTop: 16, flexWrap: 'wrap' }}>
        <label><input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Enabled</label>
        <label><input type="checkbox" checked={form.statusChecksEnabled} onChange={(e) => setForm({ ...form, statusChecksEnabled: e.target.checked })} /> AI status checks</label>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button style={button} disabled={!!busy}>{busy === 'save' ? 'Saving…' : editingId ? 'Save Changes' : 'Create Dispatcher'}</button>
        {editingId && <button type="button" style={button} onClick={reset}>Cancel</button>}
      </div>
    </form>

    <div style={panel}>
      <h2 style={{ marginTop: 0 }}>Configured AI Dispatchers</h2>
      {loading ? <p>Loading…</p> : profiles.length === 0 ? <p>No AI dispatchers configured.</p> : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Name', 'Dispatch Center', 'Channel', 'Runtime', 'Actions'].map((heading) => <th key={heading} style={{ textAlign: 'left', padding: 10, borderBottom: '1px solid var(--dispatch-border)' }}>{heading}</th>)}</tr></thead>
            <tbody>{profiles.map((profile) => <tr key={profile.id}>
              <td style={{ padding: 10 }}>
                <strong>{profile.name}</strong>
                <div style={{ fontSize: 12, color: 'var(--dispatch-muted)' }}>{profile.enabled ? 'Enabled' : 'Disabled'} · checks {profile.statusChecksEnabled ? 'on' : 'off'}</div>
                {profile.lastError && <div style={{ fontSize: 12, color: '#ef4444' }}>{profile.lastError}</div>}
              </td>
              <td style={{ padding: 10 }}>{profile.dispatchCenterName || profile.dispatchCenterId}<div style={{ fontSize: 12 }}>{profile.dispatchCenterCode || ''}</div></td>
              <td style={{ padding: 10 }}>{profile.channelName}<div style={{ fontSize: 12 }}>{profile.roomKey}</div></td>
              <td style={{ padding: 10 }}>{profile.runtime?.state || 'unknown'}<div style={{ fontSize: 12 }}>{profile.runtime?.pipeline?.pipelineStatus || ''}</div></td>
              <td style={{ padding: 10 }}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button style={button} onClick={() => edit(profile)}>Edit</button>
                {profile.enabled
                  ? <button style={button} disabled={!!busy} onClick={() => action(profile, 'stop')}>Stop</button>
                  : <button style={button} disabled={!!busy} onClick={() => action(profile, 'start')}>Start</button>}
                <button style={button} disabled={!!busy} onClick={() => action(profile, 'restart')}>Restart</button>
                <button style={{ ...button, color: '#ef4444' }} disabled={!!busy} onClick={() => action(profile, 'delete')}>Delete</button>
              </div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  </div>;
}
`;
  write(path, content);
}

// Runtime profiles are center-scoped only. Incoming audio is filtered by channel,
// not by a second manual user/radio assignment table.
{
  const path = 'src/services/aiDispatcherRuntimeManager.js';
  let content = read(path);
  content = content.replace('const UNIT_CACHE_TTL_MS = 15000;\n\n', '');
  content = content.replace('    this.unitAccessCache = new Map();\n', '');
  content = replaceExact(
    content,
    "      await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_dispatcher_profiles_center ON ai_dispatcher_profiles(dispatch_center_id)');\n      await this._migrateLegacyProfile();",
    "      await pool.query('CREATE INDEX IF NOT EXISTS idx_ai_dispatcher_profiles_center ON ai_dispatcher_profiles(dispatch_center_id)');\n      await pool.query('UPDATE ai_dispatcher_profiles SET agency_id = NULL WHERE agency_id IS NOT NULL');\n      await this._migrateLegacyProfile();",
    'profile agency cleanup migration',
  );
  content = replaceRegex(
    content,
    /    const agencies = Array\.isArray\(center\.agencies\)[\s\S]*?    if \(!agencyId && agencies\.length === 1\) agencyId = String\(agencies\[0\]\.id\);\n/,
    '    const agencyId = null;\n',
    'profile agency selection',
  );
  content = replaceExact(content, '      agencyId: profile.agency_id,', '      agencyId: null,', 'runtime agency context');
  content = replaceRegex(
    content,
    /\n  async isUnitAllowed\(dispatchCenterId, unitId\) \{[\s\S]*?\n  \}\n\n  async startProfile/,
    '\n  async startProfile',
    'manual unit access guard method',
  );
  content = content.replace('        const unitAccessGuard = (unitId) => this.isUnitAllowed(profile.dispatch_center_id, unitId);\n', '');
  content = content.replace('          unitAccessGuard,\n', '');
  content = replaceExact(
    content,
    '        const allowed = async (data) => dispatcher.matchesChannel(data.channelId) && await unitAccessGuard(data.unitId);',
    '        const allowed = async (data) => dispatcher.matchesChannel(data.channelId);',
    'channel-only incoming transmission filter',
  );
  write(path, content);
}

// Remove the now-unused constructor option from the dispatcher itself.
{
  const path = 'src/services/aiDispatchService.js';
  let content = read(path);
  content = content.replace("    this.unitAccessGuard = typeof options.unitAccessGuard === 'function' ? options.unitAccessGuard : null;\n", '');
  write(path, content);
}

// Focused regression guard for the simplified model.
{
  const path = 'src/services/__tests__/aiDispatcherCenterModel.test.js';
  const content = `import { describe, expect, it } from 'vitest';
import fs from 'fs';

describe('AI dispatcher center model', () => {
  it('accepts channel traffic without a manual unit-to-center gate', () => {
    const source = fs.readFileSync('src/services/aiDispatcherRuntimeManager.js', 'utf8');
    expect(source).toContain('dispatcher.matchesChannel(data.channelId)');
    expect(source).not.toContain('unitAccessGuard');
    expect(source).not.toContain('isUnitAllowed(');
  });

  it('does not expose the obsolete manual dispatch-center assignment UI', () => {
    const client = fs.readFileSync('client/src/main.jsx', 'utf8');
    const routes = fs.readFileSync('src/routes/index.js', 'utf8');
    expect(client).not.toContain('/admin/dispatch-centers');
    expect(routes).not.toContain('dispatch-center-assignments');
    expect(fs.existsSync('client/src/pages/DispatchCenterAssignments.jsx')).toBe(false);
    expect(fs.existsSync('src/routes/dispatchCenterAssignmentsRouter.js')).toBe(false);
  });

  it('keeps profiles scoped to a channel and dispatch center only', () => {
    const ui = fs.readFileSync('client/src/pages/AIDispatcherProfiles.jsx', 'utf8');
    expect(ui).toContain('Command Link dispatch center');
    expect(ui).not.toContain('Agency<select');
    expect(ui).not.toContain('agencyId');
  });
});
`;
  write(path, content);
}

console.log('[patch] AI dispatcher center model applied');
