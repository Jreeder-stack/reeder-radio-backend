import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";

export default function Admin({ user, onLogout }) {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("users");
  const [users, setUsers] = useState([]);
  const [channels, setChannels] = useState([]);
  const [zones, setZones] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [aiDispatchEnabled, setAiDispatchEnabled] = useState(false);
  const [aiDispatchChannel, setAiDispatchChannel] = useState("");
  const [aiDispatchLoading, setAiDispatchLoading] = useState(false);
  
  const [showAddUser, setShowAddUser] = useState(false);
  const [showEditUser, setShowEditUser] = useState(null);
  const [showAddZone, setShowAddZone] = useState(false);
  const [showAddChannel, setShowAddChannel] = useState(false);
  
  const [newUser, setNewUser] = useState({
    username: "",
    email: "",
    password: "",
    unit_id: "",
    role: "user",
    channelIds: [],
    is_dispatcher: false,
  });

  const [newZone, setNewZone] = useState("");
  const [newChannel, setNewChannel] = useState({ name: "", zoneId: "" });

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, channelsRes, zonesRes, logsRes, aiDispatchRes] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/channels", { credentials: "include" }),
        fetch("/api/admin/zones", { credentials: "include" }),
        fetch("/api/admin/logs?limit=200", { credentials: "include" }),
        fetch("/api/admin/ai-dispatch", { credentials: "include" }),
      ]);

      if (!usersRes.ok || !channelsRes.ok || !zonesRes.ok || !logsRes.ok) {
        throw new Error("Failed to load data");
      }

      const [usersData, channelsData, zonesData, logsData, aiDispatchData] = await Promise.all([
        usersRes.json(),
        channelsRes.json(),
        zonesRes.json(),
        logsRes.json(),
        aiDispatchRes.ok ? aiDispatchRes.json() : { enabled: false },
      ]);

      setUsers(usersData.users);
      setChannels(channelsData.channels);
      setZones(zonesData.zones);
      setLogs(logsData.logs);
      setAiDispatchEnabled(aiDispatchData.enabled);
      setAiDispatchChannel(aiDispatchData.channel || "");
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const createUser = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(newUser),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create user");
      }

      setShowAddUser(false);
      setNewUser({ username: "", email: "", password: "", unit_id: "", role: "user", channelIds: [], is_dispatcher: false });
      loadData();
    } catch (err) {
      alert(err.message);
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

  const deleteUser = async (userId) => {
    if (!confirm("Are you sure you want to delete this user?")) return;
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to delete user");
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  const updateUserChannels = async (userId, channelIds) => {
    try {
      const res = await fetch(`/api/admin/users/${userId}/channels`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ channelIds }),
      });

      if (!res.ok) throw new Error("Failed to update user channels");
    } catch (err) {
      alert(err.message);
    }
  };

  const resetPassword = async (userId) => {
    const password = prompt("Enter new password (min 4 characters):");
    if (!password || password.length < 4) {
      alert("Password must be at least 4 characters");
      return;
    }
    try {
      const res = await fetch(`/api/admin/users/${userId}/password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ password }),
      });

      if (!res.ok) throw new Error("Failed to reset password");
      alert("Password updated successfully");
    } catch (err) {
      alert(err.message);
    }
  };

  const createZoneHandler = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch("/api/admin/zones", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: newZone }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create zone");
      }

      setShowAddZone(false);
      setNewZone("");
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  const deleteZoneHandler = async (zoneId) => {
    if (!confirm("Delete this zone? Channels in this zone will be orphaned.")) return;
    try {
      const res = await fetch(`/api/admin/zones/${zoneId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to delete zone");
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  const createChannelHandler = async (e) => {
    e.preventDefault();
    const zone = zones.find((z) => z.id === parseInt(newChannel.zoneId));
    if (!zone) {
      alert("Please select a zone");
      return;
    }
    try {
      const res = await fetch("/api/admin/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: newChannel.name,
          zone: zone.name,
          zoneId: zone.id,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create channel");
      }

      setShowAddChannel(false);
      setNewChannel({ name: "", zoneId: "" });
      loadData();
    } catch (err) {
      alert(err.message);
    }
  };

  const deleteChannelHandler = async (channelId) => {
    if (!confirm("Delete this channel?")) return;
    try {
      const res = await fetch(`/api/admin/channels/${channelId}`, {
        method: "DELETE",
        credentials: "include",
      });

      if (!res.ok) throw new Error("Failed to delete channel");
      loadData();
    } catch (err) {
      alert(err.message);
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

  const toggleAiDispatch = async () => {
    if (!aiDispatchEnabled && !aiDispatchChannel) {
      alert("Please select a dispatch channel first");
      return;
    }
    setAiDispatchLoading(true);
    try {
      const res = await fetch("/api/admin/ai-dispatch", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ enabled: !aiDispatchEnabled, channel: aiDispatchChannel }),
      });

      if (!res.ok) throw new Error("Failed to toggle AI Dispatch");

      const data = await res.json();
      setAiDispatchEnabled(data.enabled);
      setAiDispatchChannel(data.channel || "");
    } catch (err) {
      alert("Failed to toggle AI Dispatch: " + err.message);
    } finally {
      setAiDispatchLoading(false);
    }
  };

  const updateAiDispatchChannel = async (channelName) => {
    setAiDispatchChannel(channelName);
    if (aiDispatchEnabled) {
      setAiDispatchLoading(true);
      try {
        const res = await fetch("/api/admin/ai-dispatch", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ enabled: true, channel: channelName }),
        });
        if (!res.ok) throw new Error("Failed to update channel");
        const data = await res.json();
        setAiDispatchChannel(data.channel || "");
      } catch (err) {
        alert("Failed to update dispatch channel: " + err.message);
      } finally {
        setAiDispatchLoading(false);
      }
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return "Never";
    const date = new Date(dateStr);
    if (isMobile) {
      return date.toLocaleDateString();
    }
    return date.toLocaleString();
  };

  const tabStyle = (isActive) => ({
    padding: isMobile ? "10px 16px" : "12px 24px",
    background: isActive ? "#3b82f6" : "transparent",
    color: isActive ? "#fff" : "#888",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: isMobile ? 13 : 14,
    fontWeight: 500,
    transition: "all 0.2s",
    whiteSpace: "nowrap",
  });

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid #444",
    background: "#2a2a3e",
    color: "#fff",
    fontSize: 14,
    marginTop: 4,
    boxSizing: "border-box",
  };

  const btnPrimary = {
    padding: isMobile ? "8px 16px" : "10px 20px",
    background: "#3b82f6",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 500,
  };

  const btnSecondary = {
    padding: isMobile ? "8px 16px" : "10px 20px",
    background: "#333",
    color: "#fff",
    border: "none",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 14,
  };

  const btnSmall = {
    padding: "6px 12px",
    borderRadius: 6,
    border: "none",
    cursor: "pointer",
    fontSize: 13,
  };

  const modalOverlay = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: isMobile ? 16 : 0,
  };

  const modalContent = {
    background: "#1e1e2e",
    borderRadius: 12,
    padding: isMobile ? 16 : 24,
    width: "100%",
    maxWidth: 500,
    maxHeight: "90vh",
    overflowY: "auto",
  };

  const cardStyle = {
    background: "#2a2a3e",
    borderRadius: 8,
    padding: 16,
    marginBottom: 12,
  };

  const statusBadge = (isActive, activeText = "active", inactiveText = "blocked") => ({
    display: "inline-block",
    padding: "4px 10px",
    borderRadius: 20,
    fontSize: 12,
    fontWeight: 500,
    background: isActive ? "#22c55e33" : "#dc262633",
    color: isActive ? "#22c55e" : "#dc2626",
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
          padding: isMobile ? "12px 16px" : "16px 24px",
          display: "flex",
          flexDirection: isMobile ? "column" : "row",
          justifyContent: "space-between",
          alignItems: isMobile ? "stretch" : "center",
          gap: isMobile ? 12 : 0,
          borderBottom: "1px solid #333",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24 }}>📻</span>
          <h1 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 600 }}>
            Admin Dashboard
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => navigate("/")}
            style={{ ...btnSecondary, flex: isMobile ? 1 : "none" }}
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
              flex: isMobile ? 1 : "none",
            }}
          >
            Logout
          </button>
        </div>
      </header>

      <div style={{ padding: isMobile ? 12 : 24 }}>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginBottom: 20,
            background: "#1e1e2e",
            padding: 8,
            borderRadius: 12,
            overflowX: "auto",
            WebkitOverflowScrolling: "touch",
          }}
        >
          <button style={tabStyle(activeTab === "users")} onClick={() => setActiveTab("users")}>
            Users ({users.length})
          </button>
          <button style={tabStyle(activeTab === "channels")} onClick={() => setActiveTab("channels")}>
            Zones & Channels
          </button>
          <button style={tabStyle(activeTab === "logs")} onClick={() => setActiveTab("logs")}>
            Activity Logs
          </button>
          <button style={tabStyle(activeTab === "settings")} onClick={() => setActiveTab("settings")}>
            Settings
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
          <div>
            <div style={{ marginBottom: 16 }}>
              <button style={btnPrimary} onClick={() => setShowAddUser(true)}>
                + Add User
              </button>
            </div>

            {isMobile ? (
              <div>
                {users.map((u) => (
                  <div key={u.id} style={cardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div>
                        <div style={{ fontWeight: 600, fontSize: 16 }}>{u.username}</div>
                        <div style={{ color: "#888", fontSize: 13 }}>{u.email || "No email"}</div>
                      </div>
                      <span style={statusBadge(u.status === "active")}>{u.status}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12, fontSize: 13 }}>
                      <div><span style={{ color: "#888" }}>Role:</span> {u.role}</div>
                      <div><span style={{ color: "#888" }}>Unit:</span> {u.unit_id || "-"}</div>
                      <div style={{ gridColumn: "1 / -1" }}><span style={{ color: "#888" }}>Last Login:</span> {formatDate(u.last_login)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      <button
                        onClick={() => setShowEditUser(u)}
                        style={{ ...btnSmall, background: "#3b82f633", color: "#3b82f6" }}
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => resetPassword(u.id)}
                        style={{ ...btnSmall, background: "#f5940033", color: "#f59400" }}
                      >
                        Reset PW
                      </button>
                      <select
                        value={u.role}
                        onChange={(e) => updateUser(u.id, { role: e.target.value })}
                        disabled={u.id === user.id}
                        style={{
                          padding: "6px 10px",
                          borderRadius: 6,
                          border: "1px solid #444",
                          background: "#1e1e2e",
                          color: "#fff",
                          fontSize: 13,
                        }}
                      >
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                      {u.id !== user.id && (
                        <>
                          <button
                            onClick={() => updateUser(u.id, { status: u.status === "active" ? "blocked" : "active" })}
                            style={{ ...btnSmall, background: u.status === "active" ? "#dc262633" : "#22c55e33", color: u.status === "active" ? "#dc2626" : "#22c55e" }}
                          >
                            {u.status === "active" ? "Block" : "Unblock"}
                          </button>
                          <button
                            onClick={() => deleteUser(u.id)}
                            style={{ ...btnSmall, background: "#dc262633", color: "#dc2626" }}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  background: "#1e1e2e",
                  borderRadius: 12,
                  overflow: "auto",
                }}
              >
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 800 }}>
                  <thead>
                    <tr style={{ background: "#2a2a3e" }}>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Username</th>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Email</th>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Role</th>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Status</th>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Unit ID</th>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Last Login</th>
                      <th style={{ padding: 14, textAlign: "left", fontSize: 14 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} style={{ borderBottom: "1px solid #333" }}>
                        <td style={{ padding: 14 }}>{u.username}</td>
                        <td style={{ padding: 14, color: "#888" }}>{u.email || "-"}</td>
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
                          <span style={statusBadge(u.status === "active")}>{u.status}</span>
                        </td>
                        <td style={{ padding: 14, color: "#888" }}>{u.unit_id || "-"}</td>
                        <td style={{ padding: 14, color: "#888", fontSize: 13 }}>
                          {formatDate(u.last_login)}
                        </td>
                        <td style={{ padding: 14 }}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button
                              onClick={() => setShowEditUser(u)}
                              style={{ ...btnSmall, background: "#3b82f633", color: "#3b82f6" }}
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => resetPassword(u.id)}
                              style={{ ...btnSmall, background: "#f5940033", color: "#f59400" }}
                            >
                              Reset PW
                            </button>
                            {u.id !== user.id && (
                              <>
                                <button
                                  onClick={() => updateUser(u.id, { status: u.status === "active" ? "blocked" : "active" })}
                                  style={{ ...btnSmall, background: u.status === "active" ? "#dc262633" : "#22c55e33", color: u.status === "active" ? "#dc2626" : "#22c55e" }}
                                >
                                  {u.status === "active" ? "Block" : "Unblock"}
                                </button>
                                <button
                                  onClick={() => deleteUser(u.id)}
                                  style={{ ...btnSmall, background: "#dc262633", color: "#dc2626" }}
                                >
                                  Delete
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "channels" && (
          <div style={{ display: "flex", gap: 24, flexDirection: isMobile ? "column" : "row" }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>Zones</h2>
                <button style={btnPrimary} onClick={() => setShowAddZone(true)}>
                  + Add Zone
                </button>
              </div>
              <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 16 }}>
                {zones.length === 0 ? (
                  <p style={{ color: "#888", textAlign: "center" }}>No zones yet</p>
                ) : (
                  zones.map((z) => (
                    <div
                      key={z.id}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "12px 0",
                        borderBottom: "1px solid #333",
                      }}
                    >
                      <span>{z.name}</span>
                      <button
                        onClick={() => deleteZoneHandler(z.id)}
                        style={{ ...btnSmall, background: "#dc262633", color: "#dc2626" }}
                      >
                        Delete
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div style={{ flex: isMobile ? 1 : 2 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>Channels</h2>
                <button style={btnPrimary} onClick={() => setShowAddChannel(true)}>
                  + Add Channel
                </button>
              </div>

              {isMobile ? (
                <div>
                  {channels.map((ch) => (
                    <div key={ch.id} style={cardStyle}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{ch.name}</div>
                          <div style={{ color: "#888", fontSize: 13 }}>{ch.zone}</div>
                        </div>
                        <span style={statusBadge(ch.enabled, "Enabled", "Disabled")}>
                          {ch.enabled ? "Enabled" : "Disabled"}
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })}
                          style={{ ...btnSmall, background: ch.enabled ? "#dc262633" : "#22c55e33", color: ch.enabled ? "#dc2626" : "#22c55e" }}
                        >
                          {ch.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          onClick={() => deleteChannelHandler(ch.id)}
                          style={{ ...btnSmall, background: "#dc262633", color: "#dc2626" }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ background: "#1e1e2e", borderRadius: 12, overflow: "hidden" }}>
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
                            <span style={statusBadge(ch.enabled, "Enabled", "Disabled")}>
                              {ch.enabled ? "Enabled" : "Disabled"}
                            </span>
                          </td>
                          <td style={{ padding: 14 }}>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button
                                onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })}
                                style={{ ...btnSmall, background: ch.enabled ? "#dc262633" : "#22c55e33", color: ch.enabled ? "#dc2626" : "#22c55e" }}
                              >
                                {ch.enabled ? "Disable" : "Enable"}
                              </button>
                              <button
                                onClick={() => deleteChannelHandler(ch.id)}
                                style={{ ...btnSmall, background: "#dc262633", color: "#dc2626" }}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "logs" && (
          <div>
            {isMobile ? (
              <div style={{ maxHeight: "70vh", overflowY: "auto" }}>
                {logs.map((log) => (
                  <div key={log.id} style={cardStyle}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
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
                      <span style={{ color: "#888", fontSize: 12 }}>{formatDate(log.created_at)}</span>
                    </div>
                    <div style={{ fontSize: 14 }}>
                      <strong>{log.username || "-"}</strong>
                      {log.channel && <span style={{ color: "#888" }}> on {log.channel}</span>}
                    </div>
                    {log.details && (
                      <div style={{ color: "#666", fontSize: 12, marginTop: 4, wordBreak: "break-all" }}>
                        {JSON.stringify(log.details)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
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
        )}

        {activeTab === "settings" && (
          <div style={{ maxWidth: 600, maxHeight: isMobile ? "calc(100vh - 200px)" : "none", overflowY: isMobile ? "auto" : "visible", WebkitOverflowScrolling: "touch" }}>
            <h2 style={{ margin: "0 0 24px", fontSize: 20 }}>System Settings</h2>
            
            <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>AI Voice Dispatcher</h3>
                  <p style={{ margin: "8px 0 0", color: "#888", fontSize: 14 }}>
                    When enabled, the AI dispatcher listens to radio traffic and responds to common commands like "radio check", "status check", and "traffic stop".
                  </p>
                </div>
                <button
                  onClick={toggleAiDispatch}
                  disabled={aiDispatchLoading}
                  style={{
                    padding: "12px 24px",
                    borderRadius: 8,
                    border: "none",
                    cursor: aiDispatchLoading ? "not-allowed" : "pointer",
                    fontSize: 14,
                    fontWeight: 600,
                    minWidth: 100,
                    background: aiDispatchEnabled ? "#22c55e" : "#444",
                    color: "#fff",
                    transition: "all 0.2s",
                    opacity: aiDispatchLoading ? 0.6 : 1,
                  }}
                >
                  {aiDispatchLoading ? "..." : aiDispatchEnabled ? "ON" : "OFF"}
                </button>
              </div>
              
              <div style={{ marginTop: 16 }}>
                <label style={{ display: "block", fontSize: 14, color: "#888", marginBottom: 8 }}>
                  Dispatch Channel (AI will only monitor this channel)
                </label>
                <select
                  value={aiDispatchChannel}
                  onChange={(e) => updateAiDispatchChannel(e.target.value)}
                  disabled={aiDispatchLoading}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: 6,
                    border: "1px solid #444",
                    background: "#2a2a3e",
                    color: "#fff",
                    fontSize: 14,
                  }}
                >
                  <option value="">Select a channel...</option>
                  {channels.filter(c => c.enabled).map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>

              {aiDispatchEnabled && aiDispatchChannel && (
                <div style={{ marginTop: 16, padding: 12, background: "#22c55e22", borderRadius: 8, border: "1px solid #22c55e44" }}>
                  <p style={{ margin: 0, color: "#22c55e", fontSize: 13 }}>
                    AI Dispatcher is active on channel: <strong>{aiDispatchChannel}</strong>
                  </p>
                </div>
              )}
            </div>

            <div style={{ marginTop: 24, background: "#1e1e2e", borderRadius: 12, padding: 24 }}>
              <h3 style={{ margin: "0 0 12px", fontSize: 16, fontWeight: 600 }}>Supported Commands</h3>
              <div style={{ color: "#888", fontSize: 14 }}>
                <div style={{ display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #333" }}>
                    <span>"radio check"</span>
                    <span style={{ color: "#22c55e" }}>"Loud and clear."</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #333" }}>
                    <span>"status check"</span>
                    <span style={{ color: "#22c55e" }}>"Go ahead."</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #333" }}>
                    <span>"traffic stop"</span>
                    <span style={{ color: "#22c55e" }}>"Copy traffic stop."</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #333" }}>
                    <span>"clear"</span>
                    <span style={{ color: "#22c55e" }}>"Copy, clear."</span>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0" }}>
                    <span>"need assistance"</span>
                    <span style={{ color: "#22c55e" }}>"Copy. Assistance requested."</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {showAddUser && (
        <div style={modalOverlay} onClick={() => setShowAddUser(false)}>
          <div style={modalContent} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: "0 0 20px", fontSize: 20 }}>Add New User</h2>
            <form onSubmit={createUser}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Username *</label>
                <input
                  type="text"
                  required
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Email</label>
                <input
                  type="email"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Password *</label>
                <input
                  type="password"
                  required
                  minLength={4}
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Unit ID</label>
                <input
                  type="text"
                  value={newUser.unit_id}
                  onChange={(e) => setNewUser({ ...newUser, unit_id: e.target.value })}
                  style={inputStyle}
                  placeholder="e.g., UNIT-001"
                />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Role</label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  style={inputStyle}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={newUser.is_dispatcher}
                    onChange={(e) => setNewUser({ ...newUser, is_dispatcher: e.target.checked })}
                  />
                  <span style={{ fontSize: 14, color: "#fff" }}>Dispatcher Access</span>
                  <span style={{ fontSize: 12, color: "#888" }}>(Can use Dispatcher Console)</span>
                </label>
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 14, color: "#888", display: "block", marginBottom: 8 }}>
                  Channel Access
                </label>
                <div style={{ maxHeight: 150, overflowY: "auto", background: "#2a2a3e", borderRadius: 6, padding: 10 }}>
                  {channels.map((ch) => (
                    <label key={ch.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={newUser.channelIds.includes(ch.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setNewUser({ ...newUser, channelIds: [...newUser.channelIds, ch.id] });
                          } else {
                            setNewUser({ ...newUser, channelIds: newUser.channelIds.filter((id) => id !== ch.id) });
                          }
                        }}
                      />
                      <span>{ch.name}</span>
                      <span style={{ color: "#666", fontSize: 12 }}>({ch.zone})</span>
                    </label>
                  ))}
                </div>
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <button type="submit" style={btnPrimary}>Create User</button>
                <button type="button" style={btnSecondary} onClick={() => setShowAddUser(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showEditUser && (
        <EditUserModal
          user={showEditUser}
          channels={channels}
          isMobile={isMobile}
          onClose={() => setShowEditUser(null)}
          onSave={async (updates, channelIds) => {
            await updateUser(showEditUser.id, updates);
            await updateUserChannels(showEditUser.id, channelIds);
            setShowEditUser(null);
            loadData();
          }}
        />
      )}

      {showAddZone && (
        <div style={modalOverlay} onClick={() => setShowAddZone(false)}>
          <div style={modalContent} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: "0 0 20px", fontSize: 20 }}>Add New Zone</h2>
            <form onSubmit={createZoneHandler}>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Zone Name *</label>
                <input
                  type="text"
                  required
                  value={newZone}
                  onChange={(e) => setNewZone(e.target.value)}
                  style={inputStyle}
                  placeholder="e.g., Zone 4 - Medical"
                />
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <button type="submit" style={btnPrimary}>Create Zone</button>
                <button type="button" style={btnSecondary} onClick={() => setShowAddZone(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddChannel && (
        <div style={modalOverlay} onClick={() => setShowAddChannel(false)}>
          <div style={modalContent} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: "0 0 20px", fontSize: 20 }}>Add New Channel</h2>
            <form onSubmit={createChannelHandler}>
              <div style={{ marginBottom: 16 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Channel Name *</label>
                <input
                  type="text"
                  required
                  value={newChannel.name}
                  onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })}
                  style={inputStyle}
                  placeholder="e.g., MED1"
                />
              </div>
              <div style={{ marginBottom: 20 }}>
                <label style={{ fontSize: 14, color: "#888" }}>Zone *</label>
                <select
                  required
                  value={newChannel.zoneId}
                  onChange={(e) => setNewChannel({ ...newChannel, zoneId: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">Select a zone...</option>
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>{z.name}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: "flex", gap: 12 }}>
                <button type="submit" style={btnPrimary}>Create Channel</button>
                <button type="button" style={btnSecondary} onClick={() => setShowAddChannel(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function EditUserModal({ user, channels, isMobile, onClose, onSave }) {
  const [email, setEmail] = useState(user.email || "");
  const [unitId, setUnitId] = useState(user.unit_id || "");
  const [isDispatcher, setIsDispatcher] = useState(user.is_dispatcher || false);
  const [channelIds, setChannelIds] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/users/${user.id}/channels`, { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        setChannelIds(data.channelIds || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [user.id]);

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave({ email, unit_id: unitId, is_dispatcher: isDispatcher }, channelIds);
  };

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 6,
    border: "1px solid #444",
    background: "#2a2a3e",
    color: "#fff",
    fontSize: 14,
    marginTop: 4,
    boxSizing: "border-box",
  };

  const modalOverlay = {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0,0,0,0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
    padding: isMobile ? 16 : 0,
  };

  const modalContent = {
    background: "#1e1e2e",
    borderRadius: 12,
    padding: isMobile ? 16 : 24,
    width: "100%",
    maxWidth: 500,
    maxHeight: "90vh",
    overflowY: "auto",
  };

  return (
    <div style={modalOverlay} onClick={onClose}>
      <div style={modalContent} onClick={(e) => e.stopPropagation()}>
        <h2 style={{ margin: "0 0 20px", fontSize: 20 }}>Edit User: {user.username}</h2>
        {loading ? (
          <p>Loading...</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 14, color: "#888" }}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 14, color: "#888" }}>Unit ID</label>
              <input
                type="text"
                value={unitId}
                onChange={(e) => setUnitId(e.target.value)}
                style={inputStyle}
                placeholder="e.g., UNIT-001"
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={isDispatcher}
                  onChange={(e) => setIsDispatcher(e.target.checked)}
                />
                <span style={{ fontSize: 14, color: "#fff" }}>Dispatcher Access</span>
                <span style={{ fontSize: 12, color: "#888" }}>(Can use Dispatcher Console)</span>
              </label>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ fontSize: 14, color: "#888", display: "block", marginBottom: 8 }}>
                Channel Access
              </label>
              <div style={{ maxHeight: 150, overflowY: "auto", background: "#2a2a3e", borderRadius: 6, padding: 10 }}>
                {channels.map((ch) => (
                  <label key={ch.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={channelIds.includes(ch.id)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setChannelIds([...channelIds, ch.id]);
                        } else {
                          setChannelIds(channelIds.filter((id) => id !== ch.id));
                        }
                      }}
                    />
                    <span>{ch.name}</span>
                    <span style={{ color: "#666", fontSize: 12 }}>({ch.zone})</span>
                  </label>
                ))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 12 }}>
              <button
                type="submit"
                style={{
                  padding: isMobile ? "8px 16px" : "10px 20px",
                  background: "#3b82f6",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                Save Changes
              </button>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: isMobile ? "8px 16px" : "10px 20px",
                  background: "#333",
                  color: "#fff",
                  border: "none",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 14,
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
