import { useEffect, useState, useCallback } from "react";

const CATEGORIES = [
  "LOCATION_ALIAS",
  "CALLSIGN_NICKNAME",
  "PHRASING_ALIAS",
  "TEN_CODE_SYNONYM",
  "NOTE_SHORTHAND",
];

export default function AiLearningReview() {
  const [candidates, setCandidates] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState({});
  const [statusFilter, setStatusFilter] = useState("pending");
  const [pendingCount, setPendingCount] = useState(0);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cRes, iRes, pRes] = await Promise.all([
        fetch(`/api/admin/learning/candidates?status=${statusFilter}`, { credentials: "include" }),
        fetch("/api/admin/learning/items", { credentials: "include" }),
        fetch("/api/admin/learning/pending-count", { credentials: "include" }),
      ]);
      if (!cRes.ok) throw new Error("Failed to load candidates");
      if (!iRes.ok) throw new Error("Failed to load items");
      const cData = await cRes.json();
      const iData = await iRes.json();
      setCandidates(cData.candidates || []);
      setItems(iData.items || []);
      if (pRes.ok) {
        const pData = await pRes.json();
        setPendingCount(typeof pData.count === "number" ? pData.count : 0);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { reload(); }, [reload]);

  const setEdit = (id, field, val) => {
    setEditing(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: val } }));
  };

  const approve = async (id) => {
    const e = editing[id] || {};
    const body = {
      editedOriginal: e.original ?? null,
      editedCorrection: e.correction ?? null,
      editedCategory: e.category ?? null,
    };
    const res = await fetch(`/api/admin/learning/candidates/${id}/approve`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(d?.error || "Approve failed");
      return;
    }
    reload();
  };

  const reject = async (id) => {
    const reason = window.prompt("Reason for rejecting? (optional)", "");
    if (reason === null) return;
    const res = await fetch(`/api/admin/learning/candidates/${id}/reject`, {
      method: "POST", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) { alert("Reject failed"); return; }
    reload();
  };

  const removeItem = async (id) => {
    if (!window.confirm("Delete this learned item?")) return;
    const res = await fetch(`/api/admin/learning/items/${id}`, {
      method: "DELETE", credentials: "include",
    });
    if (!res.ok) { alert("Delete failed"); return; }
    reload();
  };

  return (
    <div className="admin-settings-card">
      <div className="admin-settings-card-header">
        <div>
          <h3 className="admin-settings-card-title">
            AI Dispatcher Learning
            {pendingCount > 0 && (
              <span style={{
                marginLeft: 8, padding: "2px 8px", borderRadius: 12,
                background: "#d9534f", color: "white", fontSize: 12,
              }}>{pendingCount} pending</span>
            )}
          </h3>
          <p className="admin-settings-card-desc">
            Review operator corrections and "remember that..." teachings before they influence the AI dispatcher.
            Approved items only affect address/callsign/phrasing recognition — never personality, tier rules, 10-code semantics, escalation, or safety behavior.
          </p>
        </div>
        <button onClick={reload} disabled={loading} className="admin-toggle-btn admin-toggle-btn-action">
          {loading ? "..." : "Refresh"}
        </button>
      </div>

      {error && <div style={{ color: "#c0392b", marginTop: 8 }}>{error}</div>}

      <div className="admin-field" style={{ marginTop: 12 }}>
        <label className="admin-field-label">Show candidates</label>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="admin-select">
          <option value="pending">Pending</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="all">All</option>
        </select>
      </div>

      <div style={{ marginTop: 12, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
              <th style={{ padding: 6 }}>When</th>
              <th style={{ padding: 6 }}>Unit</th>
              <th style={{ padding: 6 }}>Category</th>
              <th style={{ padding: 6 }}>Original</th>
              <th style={{ padding: 6 }}>Correction</th>
              <th style={{ padding: 6 }}>Source</th>
              <th style={{ padding: 6 }}>Status</th>
              <th style={{ padding: 6 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {candidates.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 12, color: "#888" }}>No candidates.</td></tr>
            )}
            {candidates.map(c => {
              const e = editing[c.id] || {};
              const isPending = c.status === "pending";
              return (
                <tr key={c.id} style={{ borderBottom: "1px solid #eee" }}>
                  <td style={{ padding: 6, whiteSpace: "nowrap" }}>{new Date(c.created_at).toLocaleString()}</td>
                  <td style={{ padding: 6 }}>{c.unit_id || "-"}</td>
                  <td style={{ padding: 6 }}>
                    {isPending ? (
                      <select value={e.category ?? c.category} onChange={(ev) => setEdit(c.id, "category", ev.target.value)} className="admin-select">
                        {CATEGORIES.map(cat => <option key={cat} value={cat}>{cat}</option>)}
                      </select>
                    ) : c.category}
                  </td>
                  <td style={{ padding: 6 }}>
                    {isPending ? (
                      <input value={e.original ?? c.original_text} onChange={(ev) => setEdit(c.id, "original", ev.target.value)} className="admin-input" style={{ width: 180 }} />
                    ) : c.original_text}
                  </td>
                  <td style={{ padding: 6 }}>
                    {isPending ? (
                      <input value={e.correction ?? c.correction_text} onChange={(ev) => setEdit(c.id, "correction", ev.target.value)} className="admin-input" style={{ width: 220 }} />
                    ) : c.correction_text}
                  </td>
                  <td style={{ padding: 6 }}>{c.source_intent || "-"}</td>
                  <td style={{ padding: 6 }}>
                    {c.status}
                    {c.reject_reason && <div style={{ fontSize: 11, color: "#c0392b" }}>{c.reject_reason}</div>}
                  </td>
                  <td style={{ padding: 6, whiteSpace: "nowrap" }}>
                    {isPending && (
                      <>
                        <button onClick={() => approve(c.id)} className="admin-toggle-btn admin-toggle-btn-on" style={{ marginRight: 6 }}>Approve</button>
                        <button onClick={() => reject(c.id)} className="admin-toggle-btn admin-toggle-btn-off">Reject</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h4 style={{ marginTop: 18 }}>Active learned items ({items.length})</h4>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #ccc", textAlign: "left" }}>
              <th style={{ padding: 6 }}>Category</th>
              <th style={{ padding: 6 }}>Key</th>
              <th style={{ padding: 6 }}>Value</th>
              <th style={{ padding: 6 }}>Updated</th>
              <th style={{ padding: 6 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={5} style={{ padding: 12, color: "#888" }}>No active learned items.</td></tr>
            )}
            {items.map(i => (
              <tr key={i.id} style={{ borderBottom: "1px solid #eee" }}>
                <td style={{ padding: 6 }}>{i.category}</td>
                <td style={{ padding: 6 }}>{i.key_text}</td>
                <td style={{ padding: 6 }}>{i.value_text}</td>
                <td style={{ padding: 6 }}>{new Date(i.updated_at).toLocaleString()}</td>
                <td style={{ padding: 6 }}>
                  <button onClick={() => removeItem(i.id)} className="admin-toggle-btn admin-toggle-btn-off">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
