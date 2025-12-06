import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function Admin({ user, onLogout }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, channelsRes, logsRes] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/channels", { credentials: "include" }),
        fetch("/api/admin/logs?limit=200", { credentials: "include" }),
      ]);

      if (!usersRes.ok || !channelsRes.ok || !logsRes.ok) {
        throw new Error("Failed to load data");
      }

      const [usersData, channelsData, logsData] = await Promise.all([
        usersRes.json(),
        channelsRes.json(),
        logsRes.json(),
      ]);

      setUsers(usersData.users);
      setChannels(channelsData.channels);
      setLogs(logsData.logs);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const updateUser = async (userId, updates) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });

      if (!res.ok) throw new Error("Failed to update user");

      setUsers((prev) =>
        prev.map((u) => (u.id === userId ? { ...u, ...updates } : u))
      );
    } catch (err) {
      alert("Failed to update user: " + err.message);
    }
  };

  const updateChannel = async (channelId, updates) => {
    try {
      const res = await fetch(`/api/admin/channels/${channelId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(updates),
      });

      if (!res.ok) throw new Error("Failed to update channel");

      setChannels((prev) =>
        prev.map((c) => (c.id === channelId ? { ...c, ...updates } : c))
      );
    } catch (err) {
      alert("Failed to update channel: " + err.message);
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    return date.toLocaleString();
  };

  const tabStyle = (isActive) => ({
    padding: "12px 24px",
    background: isActive ? "#3b82f6" : "transparent",
    color: isActive ? "#fff" : "#888",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
    transition: "all 0.2s",
  });

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#1a1a2e",
          color: "#fff",
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#1a1a2e",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "#fff",
      }}
    >
      <header
        style={{
          background: "#1e1e2e",
          padding: "16px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #333",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: 24 }}>📻</span>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>
            Admin Dashboard
          </h1>
        </div>
        <div style={{ display: "flex", gap: 12 }}>
          <button
            onClick={() => navigate("/")}
            style={{
              padding: "8px 16px",
              background: "#333",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Back to Radio
          </button>
          <button
            onClick={onLogout}
            style={{
              padding: "8px 16px",
              background: "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <div style={{ padding: 24 }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 24,
            background: "#1e1e2e",
            padding: 8,
            borderRadius: 12,
            width: "fit-content",
          }}
        >
          <button style={tabStyle(activeTab === "users")} onClick={() => setActiveTab("users")}>
            Users ({users.length})
          </button>
          <button style={tabStyle(activeTab === "channels")} onClick={() => setActiveTab("channels")}>
            Channels ({channels.length})
          </button>
          <button style={tabStyle(activeTab === "logs")} onClick={() => setActiveTab("logs")}>
            Activity Logs
          </button>
        </div>

        {error && (
          <div
            style={{
              background: "#dc2626",
              padding: "12px 16px",
              borderRadius: 8,
              marginBottom: 20,
            }}
          >
            {error}
          </div>
        )}

        {activeTab === "users" && (
          <div
            style={{
              background: "#1e1e2e",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#2a2a3e" }}>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Username</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Role</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Status</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Unit ID</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Created</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Last Login</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: "1px solid #333" }}>
                    <td style={{ padding: 14 }}>{u.username}</td>
                    <td style={{ padding: 14 }}>
                      <select
                        value={u.role}
                        onChange={(e) => updateUser(u.id, { role: e.target.value })}
                        disabled={u.id === user.id}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 6,
                          border: "1px solid #444",
                          background: "#2a2a3e",
                          color: "#fff",
                        }}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td style={{ padding: 14 }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "4px 10px",
                          borderRadius: 20,
                          fontSize: 12,
                          fontWeight: 500,
                          background: u.status === "active" ? "#22c55e33" : "#dc262633",
                          color: u.status === "active" ? "#22c55e" : "#dc2626",
                        }}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td style={{ padding: 14, color: "#888" }}>{u.unit_id || "-"}</td>
                    <td style={{ padding: 14, color: "#888", fontSize: 13 }}>
                      {formatDate(u.created_at)}
                    </td>
                    <td style={{ padding: 14, color: "#888", fontSize: 13 }}>
                      {formatDate(u.last_login)}
                    </td>
                    <td style={{ padding: 14 }}>
                      {u.id !== user.id && (
                        <button
                          onClick={() =>
                            updateUser(u.id, {
                              status: u.status === "active" ? "blocked" : "active",
                            })
                          }
                          style={{
                            padding: "6px 12px",
                            borderRadius: 6,
                            border: "none",
                            background: u.status === "active" ? "#dc262633" : "#22c55e33",
                            color: u.status === "active" ? "#dc2626" : "#22c55e",
                            cursor: "pointer",
                            fontSize: 13,
                          }}
                        >
                          {u.status === "active" ? "Block" : "Unblock"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === "channels" && (
          <div
            style={{
              background: "#1e1e2e",
              borderRadius: 12,
              overflow: "hidden",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#2a2a3e" }}>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Channel</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Zone</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Status</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {channels.map((ch) => (
                  <tr key={ch.id} style={{ borderBottom: "1px solid #333" }}>
                    <td style={{ padding: 14, fontWeight: 500 }}>{ch.name}</td>
                    <td style={{ padding: 14, color: "#888" }}>{ch.zone}</td>
                    <td style={{ padding: 14 }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "4px 10px",
                          borderRadius: 20,
                          fontSize: 12,
                          fontWeight: 500,
                          background: ch.enabled ? "#22c55e33" : "#dc262633",
                          color: ch.enabled ? "#22c55e" : "#dc2626",
                        }}
                      >
                        {ch.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </td>
                    <td style={{ padding: 14 }}>
                      <button
                        onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })}
                        style={{
                          padding: "6px 12px",
                          borderRadius: 6,
                          border: "none",
                          background: ch.enabled ? "#dc262633" : "#22c55e33",
                          color: ch.enabled ? "#dc2626" : "#22c55e",
                          cursor: "pointer",
                          fontSize: 13,
                        }}
                      >
                        {ch.enabled ? "Disable" : "Enable"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === "logs" && (
          <div
            style={{
              background: "#1e1e2e",
              borderRadius: 12,
              overflow: "hidden",
              maxHeight: "70vh",
              overflowY: "auto",
            }}
          >
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: "sticky", top: 0 }}>
                <tr style={{ background: "#2a2a3e" }}>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Time</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>User</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Action</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Channel</th>
                  <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} style={{ borderBottom: "1px solid #333" }}>
                    <td style={{ padding: 14, color: "#888", fontSize: 13 }}>
                      {formatDate(log.created_at)}
                    </td>
                    <td style={{ padding: 14 }}>{log.username || "-"}</td>
                    <td style={{ padding: 14 }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "4px 10px",
                          borderRadius: 20,
                          fontSize: 12,
                          background:
                            log.action === "emergency"
                              ? "#dc262633"
                              : log.action === "login"
                              ? "#3b82f633"
                              : "#6b728033",
                          color:
                            log.action === "emergency"
                              ? "#dc2626"
                              : log.action === "login"
                              ? "#3b82f6"
                              : "#9ca3af",
                        }}
                      >
                        {log.action}
                      </span>
                    </td>
                    <td style={{ padding: 14, color: "#888" }}>{log.channel || "-"}</td>
                    <td style={{ padding: 14, color: "#666", fontSize: 13 }}>
                      {log.details ? JSON.stringify(log.details) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
