import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import RecordingLogs from "./RecordingLogs.jsx";
import VmLogs from "./VmLogs.jsx";

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
  const [aiDispatchPipeline, setAiDispatchPipeline] = useState(null);

  const [scannerEnabled, setScannerEnabled] = useState(false);
  const [scannerChannel, setScannerChannel] = useState("");
  const [scannerUrl, setScannerUrl] = useState("");
  const [scannerLoading, setScannerLoading] = useState(false);
  const [scannerTransmitting, setScannerTransmitting] = useState(false);

  /* --- Audio Tuning (temporary) --- */
  const [dspConfig, setDspConfig] = useState(null);
  const [dspDefaults, setDspDefaults] = useState(null);
  const [dspLoading, setDspLoading] = useState(false);
  
  const [showAddUser, setShowAddUser] = useState(false);
  const [showEditUser, setShowEditUser] = useState(null);
  const [showAddZone, setShowAddZone] = useState(false);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [expandedZones, setExpandedZones] = useState({});
  const [addChannelForZoneId, setAddChannelForZoneId] = useState(null);
  
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

  useEffect(() => {
    let interval;
    if (activeTab === "settings" && aiDispatchEnabled) {
      interval = setInterval(async () => {
        try {
          const res = await fetch("/api/admin/ai-dispatch", { credentials: "include" });
          if (res.ok) {
            const data = await res.json();
            setAiDispatchPipeline(data.pipeline || null);
          }
        } catch (err) {
          console.error("Failed to poll AI dispatch status:", err);
        }
      }, 10000);
    }
    return () => clearInterval(interval);
  }, [activeTab, aiDispatchEnabled]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, channelsRes, zonesRes, logsRes, aiDispatchRes, scannerRes] = await Promise.all([
        fetch("/api/admin/users", { credentials: "include" }),
        fetch("/api/admin/channels", { credentials: "include" }),
        fetch("/api/admin/zones", { credentials: "include" }),
        fetch("/api/admin/logs?limit=200", { credentials: "include" }),
        fetch("/api/admin/ai-dispatch", { credentials: "include" }),
        fetch("/api/admin/scanner", { credentials: "include" }),
      ]);

      if (!usersRes.ok || !channelsRes.ok || !zonesRes.ok || !logsRes.ok) {
        throw new Error("Failed to load data");
      }

      const [usersData, channelsData, zonesData, logsData, aiDispatchData, scannerData] = await Promise.all([
        usersRes.json(),
        channelsRes.json(),
        zonesRes.json(),
        logsRes.json(),
        aiDispatchRes.ok ? aiDispatchRes.json() : { enabled: false },
        scannerRes.ok ? scannerRes.json() : { running: false },
      ]);

      setUsers(usersData.users);
      setChannels(channelsData.channels);
      setZones(zonesData.zones);
      setLogs(logsData.logs);
      setAiDispatchEnabled(aiDispatchData.enabled);
      setAiDispatchChannel(aiDispatchData.channel || "");
      setAiDispatchPipeline(aiDispatchData.pipeline || null);
      setScannerEnabled(scannerData.running || false);
      setScannerChannel(scannerData.channelName || "");
      setScannerUrl(scannerData.streamUrl || "");
      setScannerTransmitting(scannerData.transmitting || false);
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
      setAddChannelForZoneId(null);
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
      setAiDispatchPipeline(data.pipeline || null);
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

  const toggleScanner = async () => {
    if (!scannerEnabled && (!scannerChannel || !scannerUrl)) {
      alert("Please select a channel and enter a stream URL first");
      return;
    }
    setScannerLoading(true);
    try {
      const res = await fetch("/api/admin/scanner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          enabled: !scannerEnabled,
          streamUrl: scannerUrl,
          channelName: scannerChannel,
        }),
      });
      if (!res.ok) throw new Error("Failed to toggle scanner feed");
      const data = await res.json();
      setScannerEnabled(data.running || false);
      if (data.channelName) setScannerChannel(data.channelName);
      if (data.streamUrl) setScannerUrl(data.streamUrl);
      setScannerTransmitting(data.transmitting || false);
    } catch (err) {
      alert("Failed to toggle scanner feed: " + err.message);
    } finally {
      setScannerLoading(false);
    }
  };

  /* --- Audio Tuning functions (temporary) --- */
  const loadAudioTuning = async () => {
    if (dspConfig) return;
    setDspLoading(true);
    try {
      const res = await fetch("/api/admin/audio-tuning", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load audio tuning");
      const data = await res.json();
      setDspConfig(data.config);
      setDspDefaults(data.defaults);
    } catch (err) {
      alert("Failed to load audio tuning: " + err.message);
    } finally {
      setDspLoading(false);
    }
  };

  const updateDspParam = async (key, value) => {
    const updated = { ...dspConfig, [key]: value };
    setDspConfig(updated);
    try {
      await fetch("/api/admin/audio-tuning", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ [key]: value }),
      });
    } catch (err) {
      console.error("Failed to update DSP param:", err);
    }
  };

  const resetDspToDefaults = async () => {
    try {
      const res = await fetch("/api/admin/audio-tuning/reset", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to reset");
      const data = await res.json();
      setDspConfig(data.config);
    } catch (err) {
      alert("Failed to reset audio tuning: " + err.message);
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



  if (loading) {
    return (
      <div className="admin-loading-screen">
        Loading...
      </div>
    );
  }

  return (
    <div className="admin-root">
      <header className="admin-header">
        <div className="admin-header-left">
          <span style={{ fontSize: 22, lineHeight: 1 }}>📻</span>
          <h1 className="admin-header-title">Admin Dashboard</h1>
        </div>
        <div className="admin-header-actions">
          {typeof window !== "undefined" && window.electronAPI && (
            <button
              onClick={() => window.electronAPI.openSettings()}
              className="admin-btn admin-btn-ghost"
              style={{ color: "var(--dispatch-success)", borderColor: "var(--dispatch-success)" }}
            >
              Desktop Settings
            </button>
          )}
          <button onClick={() => navigate("/")} className="admin-btn admin-btn-secondary">
            Back to Radio
          </button>
          <button onClick={onLogout} className="admin-btn admin-btn-danger">
            Logout
          </button>
        </div>
      </header>

      <div className="admin-body">
        <nav className="admin-tab-bar admin-tab-scroll">
          {[
            { id: "users", label: `Users (${users.length})` },
            { id: "channels", label: "Zones & Channels" },
            { id: "logs", label: "Activity Logs" },
            { id: "settings", label: "Settings" },
            { id: "recordings", label: "Recording Logs" },
            { id: "audioTuning", label: "Audio Tuning", onClick: () => { setActiveTab("audioTuning"); loadAudioTuning(); } },
            { id: "vmLogs", label: "VM Logs" },
          ].map(({ id, label, onClick }) => (
            <button
              key={id}
              className={`admin-tab${activeTab === id ? " admin-tab-active" : ""}`}
              onClick={onClick || (() => setActiveTab(id))}
            >
              {label}
            </button>
          ))}
        </nav>

        {error && (
          <div className="admin-error-banner">
            {error}
          </div>
        )}

        {activeTab === "users" && (
          <div className="admin-tab-content">
            <div className="admin-section-header">
              <h2 className="admin-section-title">Users</h2>
              <button className="admin-btn admin-btn-primary" onClick={() => setShowAddUser(true)}>
                + Add User
              </button>
            </div>

            {isMobile ? (
              <div className="admin-card-list">
                {users.map((u) => (
                  <div key={u.id} className="admin-card">
                    <div className="admin-card-row" style={{ marginBottom: 10 }}>
                      <div>
                        <div className="admin-card-title">{u.username}</div>
                        <div className="admin-card-subtitle">{u.email || "No email"}</div>
                      </div>
                      <span className={`admin-badge ${u.status === "active" ? "admin-badge-success" : "admin-badge-danger"}`}>{u.status}</span>
                    </div>
                    <div className="admin-card-meta">
                      <span><span className="admin-label">Role:</span> {u.role}</span>
                      <span><span className="admin-label">Unit:</span> {u.unit_id || "-"}</span>
                      <span className="admin-card-meta-full"><span className="admin-label">Last Login:</span> {formatDate(u.last_login)}</span>
                    </div>
                    <div className="admin-action-row">
                      <button onClick={() => setShowEditUser(u)} className="admin-btn-sm admin-btn-sm-blue">Edit</button>
                      <button onClick={() => resetPassword(u.id)} className="admin-btn-sm admin-btn-sm-orange">Reset PW</button>
                      <select value={u.role} onChange={(e) => updateUser(u.id, { role: e.target.value })} disabled={u.id === user.id} className="admin-select-sm">
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                      {u.id !== user.id && (
                        <>
                          <button onClick={() => updateUser(u.id, { status: u.status === "active" ? "blocked" : "active" })} className={`admin-btn-sm ${u.status === "active" ? "admin-btn-sm-danger" : "admin-btn-sm-green"}`}>
                            {u.status === "active" ? "Block" : "Unblock"}
                          </button>
                          <button onClick={() => deleteUser(u.id)} className="admin-btn-sm admin-btn-sm-danger">Delete</button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Username</th>
                      <th>Email</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Unit ID</th>
                      <th>Last Login</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id}>
                        <td className="admin-td-bold">{u.username}</td>
                        <td className="admin-td-muted">{u.email || "-"}</td>
                        <td>
                          <select value={u.role} onChange={(e) => updateUser(u.id, { role: e.target.value })} disabled={u.id === user.id} className="admin-select-sm">
                            <option value="user">User</option>
                            <option value="admin">Admin</option>
                          </select>
                        </td>
                        <td>
                          <span className={`admin-badge ${u.status === "active" ? "admin-badge-success" : "admin-badge-danger"}`}>{u.status}</span>
                        </td>
                        <td className="admin-td-muted">{u.unit_id || "-"}</td>
                        <td className="admin-td-muted admin-td-sm">{formatDate(u.last_login)}</td>
                        <td>
                          <div className="admin-action-row">
                            <button onClick={() => setShowEditUser(u)} className="admin-btn-sm admin-btn-sm-blue">Edit</button>
                            <button onClick={() => resetPassword(u.id)} className="admin-btn-sm admin-btn-sm-orange">Reset PW</button>
                            {u.id !== user.id && (
                              <>
                                <button onClick={() => updateUser(u.id, { status: u.status === "active" ? "blocked" : "active" })} className={`admin-btn-sm ${u.status === "active" ? "admin-btn-sm-danger" : "admin-btn-sm-green"}`}>
                                  {u.status === "active" ? "Block" : "Unblock"}
                                </button>
                                <button onClick={() => deleteUser(u.id)} className="admin-btn-sm admin-btn-sm-danger">Delete</button>
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
          <div className="admin-tab-content">
            <div className="admin-section-header">
              <h2 className="admin-section-title">Zones & Channels</h2>
              <button className="admin-btn admin-btn-primary" onClick={() => setShowAddZone(true)}>
                + Add Zone
              </button>
            </div>

            {zones.length === 0 ? (
              <div className="admin-empty-state">
                <p>No zones yet. Create a zone to get started.</p>
              </div>
            ) : (
              <div className="admin-zone-list">
                {zones.map((z) => {
                  const zoneChannels = channels.filter((ch) => ch.zone_id === z.id || ch.zone === z.name);
                  const isExpanded = !!expandedZones[z.id];
                  return (
                    <div key={z.id} className="admin-zone-card">
                      <div
                        className={`admin-zone-header${isExpanded ? " admin-zone-header-expanded" : ""}`}
                        onClick={() => setExpandedZones((prev) => ({ ...prev, [z.id]: !prev[z.id] }))}
                      >
                        <div className="admin-zone-title-group">
                          <span className="admin-zone-chevron" style={{ transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
                          <span className="admin-zone-name">{z.name}</span>
                          <span className="admin-zone-count">{zoneChannels.length} {zoneChannels.length === 1 ? "channel" : "channels"}</span>
                        </div>
                        <div className="admin-action-row" onClick={(e) => e.stopPropagation()}>
                          <button onClick={() => { setAddChannelForZoneId(z.id); setNewChannel({ name: "", zoneId: String(z.id) }); setShowAddChannel(true); }} className="admin-btn-sm admin-btn-sm-blue">+ Channel</button>
                          <button onClick={() => deleteZoneHandler(z.id)} className="admin-btn-sm admin-btn-sm-danger">Delete</button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="admin-zone-body">
                          {zoneChannels.length === 0 ? (
                            <div className="admin-zone-empty">No channels in this zone</div>
                          ) : isMobile ? (
                            <div className="admin-card-list" style={{ padding: "8px 12px" }}>
                              {zoneChannels.map((ch) => (
                                <div key={ch.id} className="admin-card" style={{ margin: "6px 0" }}>
                                  <div className="admin-card-row" style={{ marginBottom: 8 }}>
                                    <span className="admin-card-title">{ch.name}</span>
                                    <span className={`admin-badge ${ch.enabled ? "admin-badge-success" : "admin-badge-muted"}`}>{ch.enabled ? "Enabled" : "Disabled"}</span>
                                  </div>
                                  <div className="admin-action-row">
                                    <button onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })} className={`admin-btn-sm ${ch.enabled ? "admin-btn-sm-danger" : "admin-btn-sm-green"}`}>{ch.enabled ? "Disable" : "Enable"}</button>
                                    <button onClick={() => deleteChannelHandler(ch.id)} className="admin-btn-sm admin-btn-sm-danger">Delete</button>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <table className="admin-table admin-table-nested">
                              <thead>
                                <tr>
                                  <th>Channel</th>
                                  <th>Status</th>
                                  <th style={{ textAlign: "right" }}>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {zoneChannels.map((ch) => (
                                  <tr key={ch.id}>
                                    <td className="admin-td-bold">{ch.name}</td>
                                    <td><span className={`admin-badge ${ch.enabled ? "admin-badge-success" : "admin-badge-muted"}`}>{ch.enabled ? "Enabled" : "Disabled"}</span></td>
                                    <td style={{ textAlign: "right" }}>
                                      <div className="admin-action-row" style={{ justifyContent: "flex-end" }}>
                                        <button onClick={() => updateChannel(ch.id, { enabled: !ch.enabled })} className={`admin-btn-sm ${ch.enabled ? "admin-btn-sm-danger" : "admin-btn-sm-green"}`}>{ch.enabled ? "Disable" : "Enable"}</button>
                                        <button onClick={() => deleteChannelHandler(ch.id)} className="admin-btn-sm admin-btn-sm-danger">Delete</button>
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {activeTab === "logs" && (
          <div className="admin-tab-content">
            <h2 className="admin-section-title" style={{ marginBottom: 16 }}>Activity Logs</h2>
            {isMobile ? (
              <div>
                {logs.map((log) => (
                  <div key={log.id} className="admin-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <span
                        className={`admin-badge ${log.action === "emergency" ? "admin-badge-danger" : log.action === "login" ? "admin-badge-blue" : "admin-badge-muted"}`}
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
              <div className="admin-table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>User</th>
                      <th>Action</th>
                      <th>Channel</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <tr key={log.id}>
                        <td className="admin-td-muted admin-td-sm">{formatDate(log.created_at)}</td>
                        <td className="admin-td-bold">{log.username || "-"}</td>
                        <td>
                          <span className={`admin-badge ${log.action === "emergency" ? "admin-badge-danger" : log.action === "login" ? "admin-badge-blue" : "admin-badge-muted"}`}>
                            {log.action}
                          </span>
                        </td>
                        <td className="admin-td-muted">{log.channel || "-"}</td>
                        <td className="admin-td-muted admin-td-sm">{log.details ? JSON.stringify(log.details) : "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {activeTab === "settings" && (
          <div className="admin-tab-content">
            <h2 className="admin-section-title" style={{ marginBottom: 24 }}>System Settings</h2>
            
            <div className="admin-settings-grid">
              <div className="admin-settings-card">
                <div className="admin-settings-card-header">
                  <div>
                    <h3 className="admin-settings-card-title">AI Voice Dispatcher</h3>
                    <p className="admin-settings-card-desc">
                      When enabled, the AI dispatcher listens to radio traffic and responds to common commands like "radio check", "status check", and "traffic stop".
                    </p>
                  </div>
                  <button
                    onClick={toggleAiDispatch}
                    disabled={aiDispatchLoading}
                    className={`admin-toggle-btn ${aiDispatchEnabled ? "admin-toggle-btn-on" : "admin-toggle-btn-off"}`}
                    style={{ opacity: aiDispatchLoading ? 0.6 : 1, cursor: aiDispatchLoading ? "not-allowed" : "pointer" }}
                  >
                    {aiDispatchLoading ? "..." : aiDispatchEnabled ? "ON" : "OFF"}
                  </button>
                </div>
                
                <div className="admin-field">
                  <label className="admin-field-label">Dispatch Channel (AI will only monitor this channel)</label>
                  <select value={aiDispatchChannel} onChange={(e) => updateAiDispatchChannel(e.target.value)} disabled={aiDispatchLoading} className="admin-select">
                    <option value="">Select a channel...</option>
                    {channels.filter(c => c.enabled).map((c) => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>

                {aiDispatchEnabled && aiDispatchChannel && (() => {
                  const ps = aiDispatchPipeline;
                  const isDisconnected = !ps || !ps.connected;
                  const isError = ps && (ps.pipelineStatus === 'decode_error' || ps.pipelineStatus === 'stt_error');
                  const isHealthy = ps && ps.pipelineStatus === 'healthy' && ps.connected;

                  let statusClass = "admin-status-banner-sub"; // Default/Amber
                  let statusLabel = "Connected — awaiting audio";

                  if (isDisconnected) {
                    statusClass = "admin-status-banner-danger";
                    statusLabel = "Disconnected — not listening";
                  } else if (isError) {
                    statusClass = "admin-status-banner-danger";
                    statusLabel = ps.pipelineStatus === 'decode_error' ? "Audio decode error" : "Speech recognition error";
                  } else if (isHealthy) {
                    statusClass = "admin-status-banner-success";
                    statusLabel = "Listening — pipeline healthy";
                  }

                  return (
                    <div className={`admin-status-banner ${statusClass}`} style={{ marginTop: 16 }}>
                      <div>
                        <strong>{statusLabel}</strong> — channel: <strong>{aiDispatchChannel}</strong>
                      </div>
                      {isError && ps.pipelineError && (
                        <div style={{ marginTop: 4, fontSize: '0.85em', opacity: 0.8 }}>
                          {ps.pipelineError}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              <div className="admin-settings-card">
                <h3 className="admin-settings-card-title" style={{ marginBottom: 12 }}>Supported Commands</h3>
                <div className="admin-commands-list">
                  {[
                    { cmd: '"radio check"', resp: '"Loud and clear."' },
                    { cmd: '"status check"', resp: '"Go ahead."' },
                    { cmd: '"traffic stop"', resp: '"Copy traffic stop."' },
                    { cmd: '"clear"', resp: '"Copy, clear."' },
                    { cmd: '"need assistance"', resp: '"Copy. Assistance requested."' },
                  ].map(({ cmd, resp }) => (
                    <div key={cmd} className="admin-command-row">
                      <span className="admin-command-key">{cmd}</span>
                      <span className="admin-command-resp">{resp}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="admin-settings-card">
                <div className="admin-settings-card-header">
                  <div>
                    <h3 className="admin-settings-card-title">Live Scanner Feed</h3>
                    <p className="admin-settings-card-desc">
                      Stream audio from a Broadcastify or HTTP audio stream into a channel. The scanner appears as a virtual "SCANNER" unit with real PTT behavior.
                    </p>
                  </div>
                  <button
                    onClick={toggleScanner}
                    disabled={scannerLoading}
                    className={`admin-toggle-btn ${scannerEnabled ? "admin-toggle-btn-on" : "admin-toggle-btn-off"}`}
                    style={{ opacity: scannerLoading ? 0.6 : 1, cursor: scannerLoading ? "not-allowed" : "pointer" }}
                  >
                    {scannerLoading ? "..." : scannerEnabled ? "ON" : "OFF"}
                  </button>
                </div>

                <div className="admin-field">
                  <label className="admin-field-label">Scanner Channel</label>
                  <select value={scannerChannel} onChange={(e) => setScannerChannel(e.target.value)} disabled={scannerLoading || scannerEnabled} className="admin-select">
                    <option value="">Select a channel...</option>
                    {channels.filter(c => c.enabled).map((c) => (
                      <option key={c.id} value={c.name}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div className="admin-field">
                  <label className="admin-field-label">Stream URL</label>
                  <input
                    type="text"
                    value={scannerUrl}
                    onChange={(e) => setScannerUrl(e.target.value)}
                    disabled={scannerLoading || scannerEnabled}
                    placeholder="https://broadcastify.cdnstream1.com/FEED_ID"
                    className="admin-input"
                  />
                </div>

                {scannerEnabled && scannerChannel && (
                  <div className="admin-status-banner admin-status-banner-success">
                    Scanner feed is active on channel: <strong>{scannerChannel}</strong>
                    {scannerTransmitting && <span className="admin-tx-badge">TX</span>}
                    <div className="admin-status-banner-sub">{scannerUrl}</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "recordings" && (
          <div className="admin-tab-content">
            <RecordingLogs isMobile={isMobile} />
          </div>
        )}

        {activeTab === "audioTuning" && (
          <div className="admin-tab-content">
            <div className="admin-section-header" style={{ marginBottom: 24 }}>
              <h2 className="admin-section-title">Audio Tuning</h2>
              <button onClick={resetDspToDefaults} className="admin-btn admin-btn-danger">Reset to Defaults</button>
            </div>

            {dspLoading && <p className="admin-muted-text">Loading...</p>}

            {dspConfig && (
              <div className="admin-dsp-grid">
                <div className="admin-settings-card">
                  <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--dispatch-accent)" }}>TX (Transmit)</h3>
                  <DspSlider label="HP Alpha" paramKey="txHpAlpha" value={dspConfig.txHpAlpha} min={0.9} max={0.999} step={0.001} onChange={updateDspParam} description="Controls the high-pass filter cutoff — higher values remove more low-frequency rumble" />
                  <DspSlider label="LP B0" paramKey="txLpB0" value={dspConfig.txLpB0} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Low-pass filter feedforward coefficient — shapes the amount of treble allowed through" />
                  <DspSlider label="LP B1" paramKey="txLpB1" value={dspConfig.txLpB1} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Low-pass filter first delay tap — adjusts frequency roll-off curve" />
                  <DspSlider label="LP B2" paramKey="txLpB2" value={dspConfig.txLpB2} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Low-pass filter second delay tap — fine-tunes the steepness of the roll-off" />
                  <DspSlider label="LP A1" paramKey="txLpA1" value={dspConfig.txLpA1} min={-2} max={2} step={0.0001} onChange={updateDspParam} description="Low-pass filter first feedback coefficient — controls resonance near the cutoff" />
                  <DspSlider label="LP A2" paramKey="txLpA2" value={dspConfig.txLpA2} min={-2} max={2} step={0.0001} onChange={updateDspParam} description="Low-pass filter second feedback coefficient — affects filter stability and sharpness" />
                  <DspSlider label="Comp Threshold (dB)" paramKey="txCompThresholdDb" value={dspConfig.txCompThresholdDb} min={-40} max={0} step={1} onChange={updateDspParam} description="Volume level above which compression kicks in — lower values compress more of the signal" />
                  <DspSlider label="Comp Ratio" paramKey="txCompRatio" value={dspConfig.txCompRatio} min={1} max={20} step={0.5} onChange={updateDspParam} description="How much the volume is reduced above the threshold — higher values mean stronger compression" />
                  <DspSlider label="Comp Attack (ms)" paramKey="txCompAttackMs" value={dspConfig.txCompAttackMs} min={0.001} max={0.05} step={0.001} onChange={updateDspParam} description="How quickly the compressor reacts to loud sounds — lower is faster" />
                  <DspSlider label="Comp Release (ms)" paramKey="txCompReleaseMs" value={dspConfig.txCompReleaseMs} min={0.01} max={0.5} step={0.01} onChange={updateDspParam} description="How quickly the compressor stops reducing volume after sound drops — lower is faster" />
                  <DspSlider label="TX Gain" paramKey="txGain" value={dspConfig.txGain} min={0.1} max={5.0} step={0.1} onChange={updateDspParam} description="Overall transmit volume multiplier — increase to make outgoing audio louder" />
                </div>

                <div className="admin-settings-card">
                  <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--dispatch-success)" }}>RX (Receive)</h3>
                  <DspSlider label="HP Alpha" paramKey="rxHpAlpha" value={dspConfig.rxHpAlpha} min={0.9} max={0.999} step={0.001} onChange={updateDspParam} description="Controls the receive high-pass filter cutoff — removes low-frequency noise from incoming audio" />
                  <DspSlider label="LP B0" paramKey="rxLpB0" value={dspConfig.rxLpB0} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Receive low-pass feedforward coefficient — shapes treble on incoming audio" />
                  <DspSlider label="LP B1" paramKey="rxLpB1" value={dspConfig.rxLpB1} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Receive low-pass first delay tap — adjusts incoming audio roll-off curve" />
                  <DspSlider label="LP B2" paramKey="rxLpB2" value={dspConfig.rxLpB2} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Receive low-pass second delay tap — fine-tunes incoming audio roll-off steepness" />
                  <DspSlider label="LP A1" paramKey="rxLpA1" value={dspConfig.rxLpA1} min={-2} max={2} step={0.0001} onChange={updateDspParam} description="Receive low-pass first feedback coefficient — controls resonance on incoming audio" />
                  <DspSlider label="LP A2" paramKey="rxLpA2" value={dspConfig.rxLpA2} min={-2} max={2} step={0.0001} onChange={updateDspParam} description="Receive low-pass second feedback coefficient — affects incoming filter stability" />
                  <DspSlider label="Noise Gate (dB)" paramKey="rxGateThresholdDb" value={dspConfig.rxGateThresholdDb} min={-80} max={0} step={1} onChange={updateDspParam} description="Audio below this level is silenced — raise to cut out background noise between transmissions" />
                  <DspSlider label="RX Gain" paramKey="rxGain" value={dspConfig.rxGain} min={0.1} max={10.0} step={0.1} onChange={updateDspParam} description="Overall receive volume multiplier — increase to make incoming audio louder" />
                </div>

                <div className="admin-settings-card">
                  <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600, color: "var(--dispatch-warning)" }}>Codec</h3>
                  <DspSlider label="Opus Bitrate" paramKey="opusBitrate" value={dspConfig.opusBitrate} min={6000} max={128000} step={1000} onChange={updateDspParam} description="Target bitrate for Opus encoding — higher values mean better quality but more bandwidth" />
                </div>
              </div>
            )}

            {dspConfig && (
              <div className="admin-settings-card" style={{ marginTop: 24 }}>
                <h3 className="admin-muted-text" style={{ margin: "0 0 12px", fontSize: 13 }}>Current Config (JSON)</h3>
                <pre className="admin-json-pre">{JSON.stringify(dspConfig, null, 2)}</pre>
              </div>
            )}
          </div>
        )}

        {activeTab === "vmLogs" && (
          <div className="admin-tab-content">
            <VmLogs isMobile={isMobile} />
          </div>
        )}
      </div>

      {showAddUser && (
        <div className="admin-modal-overlay" onClick={() => setShowAddUser(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="admin-modal-title">Add New User</h2>
            <form onSubmit={createUser}>
              <div className="admin-field">
                <label className="admin-field-label">Username *</label>
                <input type="text" required value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} className="admin-input" />
              </div>
              <div className="admin-field">
                <label className="admin-field-label">Email</label>
                <input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} className="admin-input" />
              </div>
              <div className="admin-field">
                <label className="admin-field-label">Password *</label>
                <input type="password" required minLength={4} value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className="admin-input" />
              </div>
              <div className="admin-field">
                <label className="admin-field-label">Unit ID</label>
                <input type="text" value={newUser.unit_id} onChange={(e) => setNewUser({ ...newUser, unit_id: e.target.value })} className="admin-input" placeholder="e.g., UNIT-001" />
              </div>
              <div className="admin-field">
                <label className="admin-field-label">Role</label>
                <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })} className="admin-select">
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div className="admin-field">
                <label className="admin-checkbox-label">
                  <input type="checkbox" checked={newUser.is_dispatcher} onChange={(e) => setNewUser({ ...newUser, is_dispatcher: e.target.checked })} />
                  <span>Dispatcher Access</span>
                  <span className="admin-muted-text">(Can use Dispatcher Console)</span>
                </label>
              </div>
              <div className="admin-field">
                <label className="admin-field-label">Channel Access</label>
                <div className="admin-checkbox-list">
                  {channels.map((ch) => (
                    <label key={ch.id} className="admin-checkbox-label">
                      <input type="checkbox" checked={newUser.channelIds.includes(ch.id)} onChange={(e) => {
                        if (e.target.checked) setNewUser({ ...newUser, channelIds: [...newUser.channelIds, ch.id] });
                        else setNewUser({ ...newUser, channelIds: newUser.channelIds.filter((id) => id !== ch.id) });
                      }} />
                      <span>{ch.name}</span>
                      <span className="admin-muted-text">({ch.zone})</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className="admin-modal-actions">
                <button type="submit" className="admin-btn admin-btn-primary">Create User</button>
                <button type="button" className="admin-btn admin-btn-secondary" onClick={() => setShowAddUser(false)}>Cancel</button>
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
        <div className="admin-modal-overlay" onClick={() => setShowAddZone(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="admin-modal-title">Add New Zone</h2>
            <form onSubmit={createZoneHandler}>
              <div className="admin-field">
                <label className="admin-field-label">Zone Name *</label>
                <input type="text" required value={newZone} onChange={(e) => setNewZone(e.target.value)} className="admin-input" placeholder="e.g., Zone 4 - Medical" />
              </div>
              <div className="admin-modal-actions">
                <button type="submit" className="admin-btn admin-btn-primary">Create Zone</button>
                <button type="button" className="admin-btn admin-btn-secondary" onClick={() => setShowAddZone(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {showAddChannel && (
        <div className="admin-modal-overlay" onClick={() => { setShowAddChannel(false); setAddChannelForZoneId(null); }}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="admin-modal-title">
              {addChannelForZoneId ? `Add Channel to ${(zones.find((z) => z.id === addChannelForZoneId) || {}).name || "Zone"}` : "Add New Channel"}
            </h2>
            <form onSubmit={createChannelHandler}>
              <div className="admin-field">
                <label className="admin-field-label">Channel Name *</label>
                <input type="text" required value={newChannel.name} onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })} className="admin-input" placeholder="e.g., MED1" autoFocus />
              </div>
              {!addChannelForZoneId && (
                <div className="admin-field">
                  <label className="admin-field-label">Zone *</label>
                  <select required value={newChannel.zoneId} onChange={(e) => setNewChannel({ ...newChannel, zoneId: e.target.value })} className="admin-select">
                    <option value="">Select a zone...</option>
                    {zones.map((z) => (
                      <option key={z.id} value={z.id}>{z.name}</option>
                    ))}
                  </select>
                </div>
              )}
              <div className="admin-modal-actions">
                <button type="submit" className="admin-btn admin-btn-primary">Create Channel</button>
                <button type="button" className="admin-btn admin-btn-secondary" onClick={() => { setShowAddChannel(false); setAddChannelForZoneId(null); }}>Cancel</button>
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

  return (
    <div className="admin-modal-overlay" onClick={onClose}>
      <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="admin-modal-title">Edit User: {user.username}</h2>
        {loading ? (
          <p className="admin-muted-text">Loading...</p>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="admin-field">
              <label className="admin-field-label">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="admin-input" />
            </div>
            <div className="admin-field">
              <label className="admin-field-label">Unit ID</label>
              <input type="text" value={unitId} onChange={(e) => setUnitId(e.target.value)} className="admin-input" placeholder="e.g., UNIT-001" />
            </div>
            <div className="admin-field">
              <label className="admin-checkbox-label">
                <input type="checkbox" checked={isDispatcher} onChange={(e) => setIsDispatcher(e.target.checked)} />
                <span>Dispatcher Access</span>
                <span className="admin-muted-text">(Can use Dispatcher Console)</span>
              </label>
            </div>
            <div className="admin-field">
              <label className="admin-field-label">Channel Access</label>
              <div className="admin-checkbox-list">
                {channels.map((ch) => (
                  <label key={ch.id} className="admin-checkbox-label">
                    <input type="checkbox" checked={channelIds.includes(ch.id)} onChange={(e) => {
                      if (e.target.checked) setChannelIds([...channelIds, ch.id]);
                      else setChannelIds(channelIds.filter((id) => id !== ch.id));
                    }} />
                    <span>{ch.name}</span>
                    <span className="admin-muted-text">({ch.zone})</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="admin-modal-actions">
              <button type="submit" className="admin-btn admin-btn-primary">Save Changes</button>
              <button type="button" className="admin-btn admin-btn-secondary" onClick={onClose}>Cancel</button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/* --- DspSlider: temporary component for Audio Tuning tab --- */
function DspSlider({ label, paramKey, value, min, max, step, onChange, description }) {
  const displayValue = typeof value === "number"
    ? (Number.isInteger(value) ? value : value.toFixed(step < 0.01 ? 4 : step < 1 ? 3 : 1))
    : value;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <label style={{ fontSize: 13, color: "#ccc" }}>{label}</label>
        <span style={{ fontSize: 13, color: "#3b82f6", fontFamily: "monospace" }}>{displayValue}</span>
      </div>
      {description && (
        <div style={{ fontSize: 11, color: "#888", marginBottom: 4, lineHeight: 1.3 }}>{description}</div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(paramKey, parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "#3b82f6" }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#666" }}>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}
