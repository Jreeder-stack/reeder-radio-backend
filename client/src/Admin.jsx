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
    flexShrink: 0,
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
        overflowY: "auto",
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
          {typeof window !== "undefined" && window.electronAPI && (
            <button
              onClick={() => window.electronAPI.openSettings()}
              style={{
                padding: "8px 16px",
                background: "#0f3460",
                color: "#4ade80",
                border: "1px solid #4ade80",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 14,
                fontWeight: 500,
                flex: isMobile ? 1 : "none",
              }}
            >
              Desktop Settings
            </button>
          )}
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
            scrollbarWidth: "none",
            msOverflowStyle: "none",
          }}
          className="admin-tab-scroll"
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
          <button style={tabStyle(activeTab === "recordings")} onClick={() => setActiveTab("recordings")}>
            Recording Logs
          </button>
          <button style={tabStyle(activeTab === "audioTuning")} onClick={() => { setActiveTab("audioTuning"); loadAudioTuning(); }}>
            Audio Tuning
          </button>
          <button style={tabStyle(activeTab === "vmLogs")} onClick={() => setActiveTab("vmLogs")}>
            VM Logs
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
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 18 }}>Zones & Channels</h2>
              <button style={btnPrimary} onClick={() => setShowAddZone(true)}>
                + Add Zone
              </button>
            </div>

            {zones.length === 0 ? (
              <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 32, textAlign: "center" }}>
                <p style={{ color: "#888", margin: 0 }}>No zones yet. Create a zone to get started.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {zones.map((z) => {
                  const zoneChannels = channels.filter((ch) => ch.zone_id === z.id || ch.zone === z.name);
                  const isExpanded = !!expandedZones[z.id];
                  return (
                    <div key={z.id} style={{ background: "#1e1e2e", borderRadius: 12, overflow: "hidden" }}>
                      <div
                        onClick={() => setExpandedZones((prev) => ({ ...prev, [z.id]: !prev[z.id] }))}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "14px 16px",
                          cursor: "pointer",
                          userSelect: "none",
                          background: isExpanded ? "#2a2a3e" : "transparent",
                          transition: "background 0.15s",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ fontSize: 14, color: "#888", transition: "transform 0.2s", transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", display: "inline-block" }}>&#9654;</span>
                          <span style={{ fontWeight: 600, fontSize: 16 }}>{z.name}</span>
                          <span style={{ background: "#333", color: "#aaa", borderRadius: 10, padding: "2px 8px", fontSize: 12, marginLeft: 4 }}>
                            {zoneChannels.length} {zoneChannels.length === 1 ? "channel" : "channels"}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={() => { setAddChannelForZoneId(z.id); setNewChannel({ name: "", zoneId: String(z.id) }); setShowAddChannel(true); }}
                            style={{ ...btnSmall, background: "#3b82f633", color: "#3b82f6" }}
                          >
                            + Channel
                          </button>
                          <button
                            onClick={() => deleteZoneHandler(z.id)}
                            style={{ ...btnSmall, background: "#dc262633", color: "#dc2626" }}
                          >
                            Delete
                          </button>
                        </div>
                      </div>

                      {isExpanded && (
                        <div style={{ borderTop: "1px solid #333" }}>
                          {zoneChannels.length === 0 ? (
                            <div style={{ padding: "16px 20px", color: "#666", fontSize: 14, textAlign: "center" }}>
                              No channels in this zone
                            </div>
                          ) : isMobile ? (
                            <div style={{ padding: "8px 12px" }}>
                              {zoneChannels.map((ch) => (
                                <div key={ch.id} style={{ ...cardStyle, margin: "6px 0" }}>
                                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                                    <span style={{ fontWeight: 500 }}>{ch.name}</span>
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
                            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                              <thead>
                                <tr style={{ background: "#252538" }}>
                                  <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 13, color: "#888", fontWeight: 500 }}>Channel</th>
                                  <th style={{ padding: "10px 16px", textAlign: "left", fontSize: 13, color: "#888", fontWeight: 500 }}>Status</th>
                                  <th style={{ padding: "10px 16px", textAlign: "right", fontSize: 13, color: "#888", fontWeight: 500 }}>Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {zoneChannels.map((ch) => (
                                  <tr key={ch.id} style={{ borderBottom: "1px solid #2a2a3e" }}>
                                    <td style={{ padding: "10px 16px", fontWeight: 500 }}>{ch.name}</td>
                                    <td style={{ padding: "10px 16px" }}>
                                      <span style={statusBadge(ch.enabled, "Enabled", "Disabled")}>
                                        {ch.enabled ? "Enabled" : "Disabled"}
                                      </span>
                                    </td>
                                    <td style={{ padding: "10px 16px", textAlign: "right" }}>
                                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
          <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
            <h2 style={{ margin: "0 0 24px", fontSize: 20 }}>System Settings</h2>
            
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 24 }}>
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
                      flexShrink: 0,
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

              <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 24 }}>
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

              <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 24 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Live Scanner Feed</h3>
                    <p style={{ margin: "8px 0 0", color: "#888", fontSize: 14 }}>
                      Stream audio from a Broadcastify or HTTP audio stream into a channel. The scanner appears as a virtual "SCANNER" unit with real PTT behavior.
                    </p>
                  </div>
                  <button
                    onClick={toggleScanner}
                    disabled={scannerLoading}
                    style={{
                      padding: "12px 24px",
                      borderRadius: 8,
                      border: "none",
                      cursor: scannerLoading ? "not-allowed" : "pointer",
                      fontSize: 14,
                      fontWeight: 600,
                      minWidth: 100,
                      flexShrink: 0,
                      background: scannerEnabled ? "#22c55e" : "#444",
                      color: "#fff",
                      transition: "all 0.2s",
                      opacity: scannerLoading ? 0.6 : 1,
                    }}
                  >
                    {scannerLoading ? "..." : scannerEnabled ? "ON" : "OFF"}
                  </button>
                </div>

                <div style={{ marginTop: 16 }}>
                  <label style={{ display: "block", fontSize: 14, color: "#888", marginBottom: 8 }}>
                    Scanner Channel
                  </label>
                  <select
                    value={scannerChannel}
                    onChange={(e) => setScannerChannel(e.target.value)}
                    disabled={scannerLoading || scannerEnabled}
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

                <div style={{ marginTop: 12 }}>
                  <label style={{ display: "block", fontSize: 14, color: "#888", marginBottom: 8 }}>
                    Stream URL
                  </label>
                  <input
                    type="text"
                    value={scannerUrl}
                    onChange={(e) => setScannerUrl(e.target.value)}
                    disabled={scannerLoading || scannerEnabled}
                    placeholder="https://broadcastify.cdnstream1.com/FEED_ID"
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      borderRadius: 6,
                      border: "1px solid #444",
                      background: "#2a2a3e",
                      color: "#fff",
                      fontSize: 14,
                      boxSizing: "border-box",
                    }}
                  />
                </div>

                {scannerEnabled && scannerChannel && (
                  <div style={{ marginTop: 16, padding: 12, background: "#22c55e22", borderRadius: 8, border: "1px solid #22c55e44" }}>
                    <p style={{ margin: 0, color: "#22c55e", fontSize: 13 }}>
                      Scanner feed is active on channel: <strong>{scannerChannel}</strong>
                      {scannerTransmitting && (
                        <span style={{ marginLeft: 8, color: "#f59e0b", fontWeight: 600 }}>TX</span>
                      )}
                    </p>
                    <p style={{ margin: "4px 0 0", color: "#888", fontSize: 12 }}>
                      {scannerUrl}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === "recordings" && (
          <RecordingLogs isMobile={isMobile} />
        )}

        {/* --- Audio Tuning Tab (temporary - remove once tuning is finalized) --- */}
        {activeTab === "audioTuning" && (
          <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch", maxHeight: "calc(100vh - 180px)", paddingBottom: 24 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <h2 style={{ margin: 0, fontSize: 20 }}>Audio Tuning</h2>
              <button
                onClick={resetDspToDefaults}
                style={{
                  padding: "10px 20px",
                  background: "#dc2626",
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  cursor: "pointer",
                  fontSize: 14,
                  fontWeight: 600,
                }}
              >
                Reset to Defaults
              </button>
            </div>

            {dspLoading && <p style={{ color: "#888" }}>Loading...</p>}

            {dspConfig && (
              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr 1fr", gap: 20 }}>
                <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "#3b82f6" }}>TX (Transmit)</h3>
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

                <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "#22c55e" }}>RX (Receive)</h3>
                  <DspSlider label="HP Alpha" paramKey="rxHpAlpha" value={dspConfig.rxHpAlpha} min={0.9} max={0.999} step={0.001} onChange={updateDspParam} description="Controls the receive high-pass filter cutoff — removes low-frequency noise from incoming audio" />
                  <DspSlider label="LP B0" paramKey="rxLpB0" value={dspConfig.rxLpB0} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Receive low-pass feedforward coefficient — shapes treble on incoming audio" />
                  <DspSlider label="LP B1" paramKey="rxLpB1" value={dspConfig.rxLpB1} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Receive low-pass first delay tap — adjusts incoming audio roll-off curve" />
                  <DspSlider label="LP B2" paramKey="rxLpB2" value={dspConfig.rxLpB2} min={0} max={1} step={0.0001} onChange={updateDspParam} description="Receive low-pass second delay tap — fine-tunes incoming audio roll-off steepness" />
                  <DspSlider label="LP A1" paramKey="rxLpA1" value={dspConfig.rxLpA1} min={-2} max={2} step={0.0001} onChange={updateDspParam} description="Receive low-pass first feedback coefficient — controls resonance on incoming audio" />
                  <DspSlider label="LP A2" paramKey="rxLpA2" value={dspConfig.rxLpA2} min={-2} max={2} step={0.0001} onChange={updateDspParam} description="Receive low-pass second feedback coefficient — affects incoming filter stability" />
                  <DspSlider label="Noise Gate (dB)" paramKey="rxGateThresholdDb" value={dspConfig.rxGateThresholdDb} min={-80} max={0} step={1} onChange={updateDspParam} description="Audio below this level is silenced — raise to cut out background noise between transmissions" />
                  <DspSlider label="RX Gain" paramKey="rxGain" value={dspConfig.rxGain} min={0.1} max={10.0} step={0.1} onChange={updateDspParam} description="Overall receive volume multiplier — increase to make incoming audio louder" />
                </div>

                <div style={{ background: "#1e1e2e", borderRadius: 12, padding: 20 }}>
                  <h3 style={{ margin: "0 0 16px", fontSize: 16, color: "#f59e0b" }}>Codec</h3>
                  <DspSlider label="Opus Bitrate" paramKey="opusBitrate" value={dspConfig.opusBitrate} min={6000} max={128000} step={1000} onChange={updateDspParam} description="Target bitrate for Opus encoding — higher values mean better quality but more bandwidth" />
                </div>
              </div>
            )}

            {dspConfig && (
              <div style={{ marginTop: 24, background: "#1e1e2e", borderRadius: 12, padding: 20 }}>
                <h3 style={{ margin: "0 0 12px", fontSize: 14, color: "#888" }}>Current Config (JSON)</h3>
                <pre style={{ background: "#111", padding: 12, borderRadius: 8, fontSize: 12, color: "#ccc", overflow: "auto", maxHeight: 200, margin: 0 }}>
                  {JSON.stringify(dspConfig, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}

        {activeTab === "vmLogs" && (
          <VmLogs isMobile={isMobile} />
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
        <div style={modalOverlay} onClick={() => { setShowAddChannel(false); setAddChannelForZoneId(null); }}>
          <div style={modalContent} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ margin: "0 0 20px", fontSize: 20 }}>
              {addChannelForZoneId ? `Add Channel to ${(zones.find((z) => z.id === addChannelForZoneId) || {}).name || "Zone"}` : "Add New Channel"}
            </h2>
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
                  autoFocus
                />
              </div>
              {!addChannelForZoneId && (
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
              )}
              <div style={{ display: "flex", gap: 12 }}>
                <button type="submit" style={btnPrimary}>Create Channel</button>
                <button type="button" style={btnSecondary} onClick={() => { setShowAddChannel(false); setAddChannelForZoneId(null); }}>Cancel</button>
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
