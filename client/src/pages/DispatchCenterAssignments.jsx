import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

export default function DispatchCenterAssignments() {
  const navigate = useNavigate();
  const [centers, setCenters] = useState([]);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState({});
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
      const [catalogRes, usersRes] = await Promise.all([
        fetch(`/api/admin/dispatch-center-assignments/catalog${forceCatalog ? "?refresh=true" : ""}`, {
          credentials: "include",
        }),
        fetch("/api/admin/dispatch-center-assignments/users", { credentials: "include" }),
      ]);

      const catalogData = await catalogRes.json().catch(() => ({}));
      const usersData = await usersRes.json().catch(() => ({}));
      if (!catalogRes.ok) throw new Error(catalogData.error || "Failed to load Command Link dispatch centers");
      if (!usersRes.ok) throw new Error(usersData.error || "Failed to load radio users");

      const nextUsers = usersData.users || [];
      setCenters(catalogData.dispatchCenters || []);
      setUsers(nextUsers);
      setSelected(Object.fromEntries(nextUsers.map((u) => [u.id, u.dispatch_center_id || ""])));
    } catch (err) {
      setError(err.message || "Failed to load dispatch center assignments");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function saveAssignment(user) {
    setSaving((prev) => ({ ...prev, [user.id]: true }));
    setError("");
    setNotice("");
    try {
      const res = await fetch(`/api/admin/dispatch-center-assignments/users/${user.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dispatch_center_id: selected[user.id] || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Failed to save assignment");
      setUsers((prev) => prev.map((u) => (u.id === user.id ? { ...u, ...data.user } : u)));
      setNotice(`${user.unit_id || user.username} is now assigned to ${data.user.dispatch_center_name || "no dispatch center"}.`);
    } catch (err) {
      setError(err.message || "Failed to save assignment");
    } finally {
      setSaving((prev) => ({ ...prev, [user.id]: false }));
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
              Assign each radio user and unit to its Command Link dispatch center.
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

          <div className="admin-section-header">
            <div>
              <h2 className="admin-section-title">Radio and Unit Ownership</h2>
              <p className="admin-muted-text" style={{ marginTop: 5 }}>
                The user record is authoritative. Physical radios inherit the center from the user they are assigned to.
              </p>
            </div>
          </div>

          {loading ? (
            <div className="admin-loading-screen" style={{ minHeight: 240 }}>Loading...</div>
          ) : centers.length === 0 ? (
            <div className="admin-empty-state">
              <p>No active dispatch centers were returned by Command Link.</p>
              <p className="admin-muted-text">Confirm CAD_URL, CAD_API_KEY, and the API key scopes.</p>
            </div>
          ) : (
            <div className="admin-table-wrap">
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
                    const dirty = (selected[u.id] || "") !== (u.dispatch_center_id || "");
                    return (
                      <tr key={u.id}>
                        <td>
                          <div className="admin-td-bold">{u.username}</div>
                          <div className="admin-td-muted admin-td-sm">{u.email || "No email"}</div>
                        </td>
                        <td className="admin-td-muted">{u.unit_id || "—"}</td>
                        <td>
                          {u.dispatch_center_name ? (
                            <div>
                              <div className="admin-td-bold">{u.dispatch_center_name}</div>
                              <div className="admin-td-muted admin-td-sm">{u.dispatch_center_code || u.dispatch_center_id}</div>
                            </div>
                          ) : (
                            <span className="admin-badge admin-badge-danger">Unassigned</span>
                          )}
                        </td>
                        <td>
                          <select
                            className="admin-select"
                            value={selected[u.id] || ""}
                            onChange={(e) => setSelected((prev) => ({ ...prev, [u.id]: e.target.value }))}
                          >
                            <option value="">Unassigned</option>
                            {sortedCenters.map((center) => (
                              <option key={center.id} value={center.id}>
                                {center.name} ({center.code})
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <button
                            className="admin-btn-sm admin-btn-sm-blue"
                            disabled={!dirty || saving[u.id]}
                            onClick={() => saveAssignment(u)}
                          >
                            {saving[u.id] ? "Saving..." : "Save"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
