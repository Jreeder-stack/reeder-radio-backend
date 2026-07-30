import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

function CenterSelect({ value, centers, disabled, onChange }) {
  return (
    <select className="admin-select" value={value || ""} disabled={disabled} onChange={onChange}>
      <option value="">Unassigned</option>
      {centers.map((center) => (
        <option key={center.id} value={center.id}>
          {center.name} ({center.code})
        </option>
      ))}
    </select>
  );
}

function AssignmentLabel({ name, code, id }) {
  if (!name) return <span className="admin-badge admin-badge-danger">Unassigned</span>;
  return (
    <div>
      <div className="admin-td-bold">{name}</div>
      <div className="admin-td-muted admin-td-sm">{code || id}</div>
    </div>
  );
}

export default function DispatchCenterAssignments() {
  const navigate = useNavigate();
  const [centers, setCenters] = useState([]);
  const [users, setUsers] = useState([]);
  const [radios, setRadios] = useState([]);
  const [selectedUsers, setSelectedUsers] = useState({});
  const [selectedRadios, setSelectedRadios] = useState({});
  const [saving, setSaving] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const sortedCenters = useMemo(
    () => [...centers].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [centers]
  );

  async function loadData(forceCatalog = false) {
    setLoading(true);
    setError("");
    try {
      const [catalogRes, usersRes, radiosRes] = await Promise.all([
        fetch(`/api/admin/dispatch-center-assignments/catalog${forceCatalog ? "?refresh=true" : ""}`, {
          credentials: "include",
        }),
        fetch("/api/admin/dispatch-center-assignments/users", { credentials: "include" }),
        fetch("/api/admin/dispatch-center-assignments/radios", { credentials: "include" }),
      ]);

      const catalogData = await catalogRes.json().catch(() => ({}));
      const usersData = await usersRes.json().catch(() => ({}));
      const radiosData = await radiosRes.json().catch(() => ({}));
      if (!catalogRes.ok) throw new Error(catalogData.error || "Failed to load Command Link dispatch centers");
      if (!usersRes.ok) throw new Error(usersData.error || "Failed to load radio users");
      if (!radiosRes.ok) throw new Error(radiosData.error || "Failed to load physical radios");

      const nextUsers = usersData.users || [];
      const nextRadios = radiosData.radios || [];
      setCenters(catalogData.dispatchCenters || []);
      setUsers(nextUsers);
      setRadios(nextRadios);
      setSelectedUsers(Object.fromEntries(nextUsers.map((u) => [u.id, u.dispatch_center_id || ""])));
      setSelectedRadios(Object.fromEntries(nextRadios.map((r) => [r.id, r.dispatch_center_id || ""])));
    } catch (err) {
      setError(err.message || "Failed to load dispatch center assignments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function saveUserAssignment(user) {
    const key = `user-${user.id}`;
    setSaving((prev) => ({ ...prev, [key]: true }));
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/admin/dispatch-center-assignments/users/${user.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_center_id: selectedUsers[user.id] || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save user assignment");
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, ...data.user } : u)));
      setNotice(`${user.unit_id || user.username} is now assigned to ${data.user.dispatch_center_name || "no dispatch center"}.`);
      await loadData();
    } catch (err) {
      setError(err.message || "Failed to save user assignment");
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function saveRadioAssignment(radio) {
    const key = `radio-${radio.id}`;
    setSaving((prev) => ({ ...prev, [key]: true }));
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/admin/dispatch-center-assignments/radios/${radio.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_center_id: selectedRadios[radio.id] || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save physical radio assignment");
      setNotice(`Radio ${radio.radio_id} is now assigned to ${data.radio.dispatch_center_name || "no dispatch center"}.`);
      await loadData();
    } catch (err) {
      setError(err.message || "Failed to save physical radio assignment");
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function syncLiveUnits() {
    setNotice("");
    setError("");
    try {
      const res = await fetch("/api/admin/dispatch-center-assignments/sync-live-units", {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to sync live units");
      setNotice(`Synchronized ${data.updated || 0} live unit record(s).`);
    } catch (err) {
      setError(err.message || "Failed to sync live units");
    }
  }

  return (
    <div className="admin-root" style={{ minHeight: "100vh" }}>
      <header className="admin-header">
        <div className="admin-header-left">
          <span style={{ fontSize: 22 }}>🏢</span>
          <div>
            <h1 className="admin-header-title">Dispatch Center Assignments</h1>
            <div className="admin-muted-text" style={{ fontSize: 12 }}>
              Assign software units and physical radios to their Command Link dispatch center.
            </div>
          </div>
        </div>
        <div className="admin-header-actions">
          <button className="admin-btn admin-btn-secondary" onClick={() => loadData(true)}>
            Refresh CAD List
          </button>
          <button className="admin-btn admin-btn-secondary" onClick={syncLiveUnits}>
            Sync Live Units
          </button>
          <button className="admin-btn admin-btn-primary" onClick={() => navigate("/admin")}>
            Back to Admin
          </button>
        </div>
      </header>

      <div className="admin-body">
        <div className="admin-tab-content">
          {error && <div className="admin-error-banner">{error}</div>}
          {notice && (
            <div style={{ padding: 12, marginBottom: 14, borderRadius: 8, background: "rgba(34,197,94,.14)", color: "var(--dispatch-success)" }}>
              {notice}
            </div>
          )}

          {loading ? (
            <div className="admin-loading-screen" style={{ minHeight: 240 }}>Loading...</div>
          ) : centers.length === 0 ? (
            <div className="admin-empty-state">
              <p>No active dispatch centers were returned by Command Link.</p>
              <p className="admin-muted-text">Confirm CAD_URL, CAD_API_KEY, and the API key scopes.</p>
            </div>
          ) : (
            <>
              <div className="admin-section-header">
                <div>
                  <h2 className="admin-section-title">Radio Users and Software Units</h2>
                  <p className="admin-muted-text" style={{ marginTop: 5 }}>
                    This is the authoritative assignment. Hardware assigned to one of these users inherits the same center.
                  </p>
                </div>
              </div>

              <div className="admin-table-wrap" style={{ marginBottom: 28 }}>
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Radio User</th>
                      <th>Unit ID</th>
                      <th>Current Assignment</th>
                      <th>Command Link Dispatch Center</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const dirty = (selectedUsers[u.id] || "") !== (u.dispatch_center_id || "");
                      const key = `user-${u.id}`;
                      return (
                        <tr key={u.id}>
                          <td>
                            <div className="admin-td-bold">{u.username}</div>
                            <div className="admin-td-muted admin-td-sm">{u.email || "No email"}</div>
                          </td>
                          <td className="admin-td-muted">{u.unit_id || "—"}</td>
                          <td>
                            <AssignmentLabel name={u.dispatch_center_name} code={u.dispatch_center_code} id={u.dispatch_center_id} />
                          </td>
                          <td>
                            <CenterSelect
                              value={selectedUsers[u.id]}
                              centers={sortedCenters}
                              onChange={(e) => setSelectedUsers((prev) => ({ ...prev, [u.id]: e.target.value }))}
                            />
                          </td>
                          <td>
                            <button
                              className="admin-btn-sm admin-btn-sm-blue"
                              disabled={!dirty || saving[key]}
                              onClick={() => saveUserAssignment(u)}
                            >
                              {saving[key] ? "Saving..." : "Save"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="admin-section-header">
                <div>
                  <h2 className="admin-section-title">Physical Radios</h2>
                  <p className="admin-muted-text" style={{ marginTop: 5 }}>
                    Assigned hardware inherits its user's center. Standalone radios can be assigned directly here.
                  </p>
                </div>
              </div>

              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Radio ID</th>
                      <th>Serial / IMEI</th>
                      <th>Assigned User</th>
                      <th>Current Assignment</th>
                      <th>Command Link Dispatch Center</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {radios.map((radio) => {
                      const inherited = Boolean(radio.assigned_unit_id);
                      const dirty = (selectedRadios[radio.id] || "") !== (radio.dispatch_center_id || "");
                      const key = `radio-${radio.id}`;
                      return (
                        <tr key={radio.id}>
                          <td className="admin-td-bold">{radio.radio_id}</td>
                          <td>
                            <div className="admin-td-muted">{radio.serial_number}</div>
                            <div className="admin-td-muted admin-td-sm">{radio.imei || "No IMEI"}</div>
                          </td>
                          <td>
                            {inherited ? (
                              <div>
                                <div className="admin-td-bold">{radio.assigned_unit_identity || radio.assigned_username}</div>
                                <div className="admin-td-muted admin-td-sm">Inherited assignment</div>
                              </div>
                            ) : (
                              <span className="admin-td-muted">Standalone</span>
                            )}
                          </td>
                          <td>
                            <AssignmentLabel name={radio.dispatch_center_name} code={radio.dispatch_center_code} id={radio.dispatch_center_id} />
                          </td>
                          <td>
                            <CenterSelect
                              value={selectedRadios[radio.id]}
                              centers={sortedCenters}
                              disabled={inherited}
                              onChange={(e) => setSelectedRadios((prev) => ({ ...prev, [radio.id]: e.target.value }))}
                            />
                          </td>
                          <td>
                            {inherited ? (
                              <span className="admin-td-muted admin-td-sm">Edit assigned user</span>
                            ) : (
                              <button
                                className="admin-btn-sm admin-btn-sm-blue"
                                disabled={!dirty || saving[key]}
                                onClick={() => saveRadioAssignment(radio)}
                              >
                                {saving[key] ? "Saving..." : "Save"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
