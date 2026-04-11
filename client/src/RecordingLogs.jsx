import { useState, useEffect, useRef } from "react";

const QUICK_FILTERS = [
  { label: "Last Hour", hours: 1 },
  { label: "Last 4 Hours", hours: 4 },
  { label: "Last 12 Hours", hours: 12 },
  { label: "Last 24 Hours", hours: 24 },
  { label: "Last 7 Days", hours: 168 },
];

function formatMilitaryTime(dateStr) {
  const d = new Date(dateStr);
  return `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function formatDuration(ms) {
  if (!ms) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function toLocalDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function RecordingLogs({ isMobile }) {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filterUnits, setFilterUnits] = useState([]);
  const [filterChannels, setFilterChannels] = useState([]);
  const [availableUnits, setAvailableUnits] = useState([]);
  const [availableChannels, setAvailableChannels] = useState([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [timeFrom, setTimeFrom] = useState("");
  const [timeTo, setTimeTo] = useState("");
  const [activeQuickFilter, setActiveQuickFilter] = useState(null);
  const [page, setPage] = useState(0);
  const [playingId, setPlayingId] = useState(null);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingZip, setExportingZip] = useState(false);
  const audioRef = useRef(null);
  const PAGE_SIZE = 50;

  useEffect(() => {
    loadFilters();
  }, []);

  useEffect(() => {
    searchLogs(page);
  }, [page]);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  const loadFilters = async () => {
    try {
      const res = await fetch("/api/recording-logs/filters", { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setAvailableUnits(data.units);
        setAvailableChannels(data.channels);
      }
    } catch (err) {
      console.error("Failed to load filters:", err);
    }
  };

  const buildQueryParams = () => {
    const params = new URLSearchParams();
    if (filterChannels.length > 0) params.set("channels", filterChannels.join(","));
    if (filterUnits.length > 0) params.set("units", filterUnits.join(","));

    let fromISO = null;
    let toISO = null;

    if (dateFrom) {
      const fromDate = new Date(dateFrom + "T" + (timeFrom || "00:00"));
      fromISO = fromDate.toISOString();
    }
    if (dateTo) {
      const toDate = new Date(dateTo + "T" + (timeTo || "23:59"));
      toISO = toDate.toISOString();
    }

    if (fromISO) params.set("from", fromISO);
    if (toISO) params.set("to", toISO);

    return params;
  };

  const searchLogs = async (pageArg) => {
    const currentPage = pageArg !== undefined ? pageArg : page;
    setLoading(true);
    try {
      const params = buildQueryParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(currentPage * PAGE_SIZE));

      const res = await fetch(`/api/recording-logs/search?${params}`, { credentials: "include" });
      const data = await res.json();
      if (data.success) {
        setLogs(data.logs);
        setTotal(data.total);
      }
    } catch (err) {
      console.error("Failed to search logs:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = () => {
    setActiveQuickFilter(null);
    setPage(0);
    searchLogs(0);
  };

  const handleQuickFilter = (hours, label) => {
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);
    setDateFrom(toLocalDateStr(from));
    setDateTo(toLocalDateStr(now));
    setTimeFrom(`${String(from.getHours()).padStart(2, "0")}:${String(from.getMinutes()).padStart(2, "0")}`);
    setTimeTo(`${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
    setActiveQuickFilter(label);
    setPage(0);

    const params = new URLSearchParams();
    if (filterChannels.length > 0) params.set("channels", filterChannels.join(","));
    if (filterUnits.length > 0) params.set("units", filterUnits.join(","));
    params.set("from", from.toISOString());
    params.set("to", now.toISOString());
    params.set("limit", String(PAGE_SIZE));
    params.set("offset", "0");

    setLoading(true);
    fetch(`/api/recording-logs/search?${params}`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        if (data.success) {
          setLogs(data.logs);
          setTotal(data.total);
        }
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  const isAudioPlayable = (log) => {
    if (!log.audio_available) return false;
    if (!log.audio_duration || log.audio_duration < 100) return false;
    return true;
  };

  const handlePlay = (log) => {
    if (!isAudioPlayable(log)) return;

    if (playingId === log.id) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      setPlayingId(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

    const audio = new Audio(encodeURI(log.audio_url));
    audio.onended = () => setPlayingId(null);
    audio.onerror = () => {
      setPlayingId(null);
      alert("Playback failed — audio may be unavailable.");
    };
    audio.play().catch(() => {
      setPlayingId(null);
      alert("Playback failed — audio may be unavailable.");
    });
    audioRef.current = audio;
    setPlayingId(log.id);
  };

  const handleDownload = (log) => {
    if (!log.audio_available) return;
    const filename = log.audio_url.split("/").pop();
    const a = document.createElement("a");
    a.href = encodeURI(log.audio_url);
    a.download = filename;
    a.click();
  };

  const handleExportPdf = async () => {
    setExportingPdf(true);
    try {
      const params = buildQueryParams();
      params.set("tz", String(-new Date().getTimezoneOffset()));
      const res = await fetch(`/api/recording-logs/export/pdf?${params}`, { credentials: "include" });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        alert(errData?.error || "PDF export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `transmission_log.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("PDF export failed:", err);
    } finally {
      setExportingPdf(false);
    }
  };

  const handleExportZip = async () => {
    setExportingZip(true);
    try {
      const params = buildQueryParams();
      params.set("tz", String(-new Date().getTimezoneOffset()));
      const res = await fetch(`/api/recording-logs/export/zip?${params}`, { credentials: "include" });
      if (!res.ok) {
        const errData = await res.json().catch(() => null);
        alert(errData?.error || "Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "recording_export.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("ZIP export failed:", err);
    } finally {
      setExportingZip(false);
    }
  };

  const handleUnitToggle = (unit) => {
    setFilterUnits((prev) =>
      prev.includes(unit) ? prev.filter((u) => u !== unit) : [...prev, unit]
    );
  };

  const handleChannelToggle = (ch) => {
    setFilterChannels((prev) =>
      prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]
    );
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const inputStyle = {
    padding: "8px 12px",
    borderRadius: 6,
    border: "1px solid var(--dispatch-border)",
    background: "var(--dispatch-panel-elevated)",
    color: "var(--dispatch-text)",
    fontSize: 13,
  };

  const chipStyle = (active) => ({
    padding: "4px 12px",
    borderRadius: 20,
    border: active ? "1px solid var(--dispatch-accent)" : "1px solid var(--dispatch-border)",
    background: active ? "var(--dispatch-accent-glow)" : "transparent",
    color: active ? "var(--dispatch-accent)" : "var(--dispatch-text-tertiary)",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  const quickBtnStyle = (active) => ({
    padding: "6px 14px",
    borderRadius: 6,
    border: active ? "none" : "1px solid var(--dispatch-border)",
    background: active ? "var(--dispatch-accent)" : "var(--dispatch-panel)",
    color: active ? "#fff" : "var(--dispatch-text-tertiary)",
    fontSize: 12,
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  return (
    <div style={{ overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 20 }}>Recording Logs</h2>

      <div style={{ background: "var(--dispatch-panel)", borderRadius: 12, padding: isMobile ? 12 : 20, marginBottom: 16, border: "1px solid var(--dispatch-border)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, color: "var(--dispatch-text-tertiary)" }}>Date From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, color: "var(--dispatch-text-tertiary)" }}>Time From (24hr)</label>
            <input
              type="time"
              value={timeFrom}
              onChange={(e) => setTimeFrom(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, color: "var(--dispatch-text-tertiary)" }}>Date To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 11, color: "var(--dispatch-text-tertiary)" }}>Time To (24hr)</label>
            <input
              type="time"
              value={timeTo}
              onChange={(e) => setTimeTo(e.target.value)}
              style={inputStyle}
            />
          </div>
        </div>

        {availableUnits.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--dispatch-text-tertiary)", display: "block", marginBottom: 4 }}>Units</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {availableUnits.map((u) => (
                <button key={u} style={chipStyle(filterUnits.includes(u))} onClick={() => handleUnitToggle(u)}>
                  {u}
                </button>
              ))}
            </div>
          </div>
        )}

        {availableChannels.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: "var(--dispatch-text-tertiary)", display: "block", marginBottom: 4 }}>Channels</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {availableChannels.map((c) => (
                <button key={c} style={chipStyle(filterChannels.includes(c))} onClick={() => handleChannelToggle(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          {QUICK_FILTERS.map((qf) => (
            <button
              key={qf.label}
              style={quickBtnStyle(activeQuickFilter === qf.label)}
              onClick={() => handleQuickFilter(qf.hours, qf.label)}
            >
              {qf.label}
            </button>
          ))}
          <button
            onClick={handleSearch}
            style={{
              padding: "8px 20px",
              borderRadius: 6,
              border: "none",
              background: "#3b82f6",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Search
          </button>
          <button
            onClick={() => {
              setDateFrom("");
              setDateTo("");
              setTimeFrom("");
              setTimeTo("");
              setFilterUnits([]);
              setFilterChannels([]);
              setActiveQuickFilter(null);
              setPage(0);
              setLoading(true);
              const params = new URLSearchParams();
              params.set("limit", String(PAGE_SIZE));
              params.set("offset", "0");
              fetch(`/api/recording-logs/search?${params}`, { credentials: "include" })
                .then((r) => r.json())
                .then((data) => {
                  if (data.success) {
                    setLogs(data.logs);
                    setTotal(data.total);
                  }
                })
                .catch(console.error)
                .finally(() => setLoading(false));
            }}
            style={{
              padding: "8px 16px",
              borderRadius: 6,
              border: "1px solid var(--dispatch-border)",
              background: "transparent",
              color: "var(--dispatch-text-tertiary)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Clear
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
        <button
          onClick={handleExportPdf}
          disabled={exportingPdf || total === 0}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #f59e0b",
            background: "#f59e0b22",
            color: "#f59e0b",
            fontSize: 13,
            cursor: total === 0 ? "not-allowed" : "pointer",
            opacity: exportingPdf ? 0.6 : 1,
          }}
        >
          {exportingPdf ? "Generating..." : "Download PDF Log"}
        </button>
        <button
          onClick={handleExportZip}
          disabled={exportingZip || total === 0}
          style={{
            padding: "8px 16px",
            borderRadius: 6,
            border: "1px solid #22c55e",
            background: "#22c55e22",
            color: "#22c55e",
            fontSize: 13,
            cursor: total === 0 ? "not-allowed" : "pointer",
            opacity: exportingZip ? 0.6 : 1,
          }}
        >
          {exportingZip ? "Generating..." : "Download All (ZIP)"}
        </button>
        <span style={{ color: "var(--dispatch-text-tertiary)", fontSize: 13, alignSelf: "center" }}>
          {total} transmission{total !== 1 ? "s" : ""} found
        </span>
      </div>

      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "var(--dispatch-text-tertiary)" }}>Loading...</div>
      ) : logs.length === 0 ? (
        <div style={{ textAlign: "center", padding: 60, color: "var(--dispatch-text-tertiary)" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🎙️</div>
          <div style={{ fontSize: 16, fontWeight: 500 }}>No recordings found</div>
          <div style={{ fontSize: 13, color: "var(--dispatch-text-tertiary)", marginTop: 8 }}>
            Adjust your filters or select a different date range
          </div>
        </div>
      ) : isMobile ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "calc(100vh - 300px)", overflowY: "auto", WebkitOverflowScrolling: "touch" }}>
          {logs.map((log) => (
            <div
              key={log.id}
              style={{
                background: "var(--dispatch-panel)",
                borderRadius: 10,
                padding: 14,
                border: playingId === log.id ? "1px solid var(--dispatch-accent)" : "1px solid var(--dispatch-border)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <div>
                  <span style={{ fontSize: 13, color: "var(--dispatch-text-secondary)" }}>{formatDate(log.created_at)}</span>
                  <span style={{ fontSize: 15, fontWeight: 600, marginLeft: 8, fontFamily: "monospace" }}>
                    {formatMilitaryTime(log.created_at)}
                  </span>
                </div>
                <span style={{ fontSize: 12, color: "var(--dispatch-text-tertiary)" }}>{formatDuration(log.audio_duration)}</span>
              </div>
              <div style={{ fontSize: 13, color: "var(--dispatch-text-secondary)", marginBottom: 10 }}>
                <span>{log.sender}</span>
                <span style={{ margin: "0 6px", color: "var(--dispatch-text-tertiary)" }}>•</span>
                <span>{log.channel}</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => handlePlay(log)}
                  disabled={!isAudioPlayable(log)}
                  title={!isAudioPlayable(log) ? (log.audio_duration === 0 ? "0-second recording" : "Audio unavailable") : ""}
                  style={{
                    flex: 1,
                    padding: "8px",
                    borderRadius: 6,
                    background: !isAudioPlayable(log) ? "var(--dispatch-bg)" : playingId === log.id ? "var(--dispatch-accent)" : "var(--dispatch-panel-elevated)",
                    color: !isAudioPlayable(log) ? "var(--dispatch-text-tertiary)" : playingId === log.id ? "#fff" : "var(--dispatch-text)",
                    fontSize: 13,
                    cursor: !isAudioPlayable(log) ? "not-allowed" : "pointer",
                    opacity: !isAudioPlayable(log) ? 0.6 : 1,
                    border: "1px solid var(--dispatch-border)",
                  }}
                >
                  {!isAudioPlayable(log) ? (log.audio_duration === 0 ? "0s" : "Unavailable") : playingId === log.id ? "⏹ Stop" : "▶ Play"}
                </button>
                <button
                  onClick={() => handleDownload(log)}
                  disabled={!log.audio_available}
                  style={{
                    flex: 1,
                    padding: "8px",
                    borderRadius: 6,
                    border: "1px solid var(--dispatch-border)",
                    background: "transparent",
                    color: !log.audio_available ? "var(--dispatch-text-tertiary)" : "var(--dispatch-text-secondary)",
                    fontSize: 13,
                    cursor: !log.audio_available ? "not-allowed" : "pointer",
                    opacity: !log.audio_available ? 0.6 : 1,
                  }}
                >
                  ⬇ Download
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: "calc(100vh - 300px)", WebkitOverflowScrolling: "touch" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--dispatch-border)" }}>
                <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--dispatch-text-tertiary)", fontWeight: 500, fontSize: 12, position: "sticky", top: 0, zIndex: 1, background: "var(--dispatch-panel)" }}>Date</th>
                <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--dispatch-text-tertiary)", fontWeight: 500, fontSize: 12, position: "sticky", top: 0, zIndex: 1, background: "var(--dispatch-panel)" }}>Time</th>
                <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--dispatch-text-tertiary)", fontWeight: 500, fontSize: 12, position: "sticky", top: 0, zIndex: 1, background: "var(--dispatch-panel)" }}>Unit</th>
                <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--dispatch-text-tertiary)", fontWeight: 500, fontSize: 12, position: "sticky", top: 0, zIndex: 1, background: "var(--dispatch-panel)" }}>Channel</th>
                <th style={{ textAlign: "left", padding: "10px 12px", color: "var(--dispatch-text-tertiary)", fontWeight: 500, fontSize: 12, position: "sticky", top: 0, zIndex: 1, background: "var(--dispatch-panel)" }}>Length</th>
                <th style={{ textAlign: "right", padding: "10px 12px", color: "var(--dispatch-text-tertiary)", fontWeight: 500, fontSize: 12, position: "sticky", top: 0, zIndex: 1, background: "var(--dispatch-panel)" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr
                  key={log.id}
                  style={{
                    borderBottom: "1px solid var(--dispatch-border)",
                    background: playingId === log.id ? "#3b82f611" : "transparent",
                  }}
                >
                  <td style={{ padding: "10px 12px" }}>{formatDate(log.created_at)}</td>
                  <td style={{ padding: "10px 12px", fontFamily: "monospace", fontWeight: 600 }}>
                    {formatMilitaryTime(log.created_at)}
                  </td>
                  <td style={{ padding: "10px 12px" }}>{log.sender}</td>
                  <td style={{ padding: "10px 12px" }}>{log.channel}</td>
                  <td style={{ padding: "10px 12px", color: "var(--dispatch-text-tertiary)" }}>{formatDuration(log.audio_duration)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>
                    <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                      <button
                        onClick={() => handlePlay(log)}
                        disabled={!isAudioPlayable(log)}
                        title={!isAudioPlayable(log) ? (log.audio_duration === 0 ? "0-second recording" : "Audio unavailable") : ""}
                        style={{
                          padding: "5px 12px",
                          borderRadius: 5,
                          border: "1px solid var(--dispatch-border)",
                          background: !isAudioPlayable(log) ? "var(--dispatch-bg)" : playingId === log.id ? "var(--dispatch-accent)" : "var(--dispatch-panel-elevated)",
                          color: !isAudioPlayable(log) ? "var(--dispatch-text-tertiary)" : playingId === log.id ? "#fff" : "var(--dispatch-text)",
                          fontSize: 12,
                          cursor: !isAudioPlayable(log) ? "not-allowed" : "pointer",
                          opacity: !isAudioPlayable(log) ? 0.6 : 1,
                        }}
                      >
                        {!isAudioPlayable(log) ? (log.audio_duration === 0 ? "0s" : "N/A") : playingId === log.id ? "⏹ Stop" : "▶ Play"}
                      </button>
                      <button
                        onClick={() => handleDownload(log)}
                        disabled={!log.audio_available}
                        style={{
                          padding: "5px 12px",
                          borderRadius: 5,
                          border: "1px solid var(--dispatch-border)",
                          background: "transparent",
                          color: !log.audio_available ? "var(--dispatch-text-tertiary)" : "var(--dispatch-text-secondary)",
                          fontSize: 12,
                          cursor: !log.audio_available ? "not-allowed" : "pointer",
                          opacity: !log.audio_available ? 0.6 : 1,
                        }}
                      >
                        ⬇
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--dispatch-border)",
              background: "transparent",
              color: page === 0 ? "var(--dispatch-text-tertiary)" : "var(--dispatch-text-secondary)",
              fontSize: 13,
              cursor: page === 0 ? "not-allowed" : "pointer",
            }}
          >
            Previous
          </button>
          <span style={{ color: "var(--dispatch-text-tertiary)", fontSize: 13 }}>
            Page {page + 1} of {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "1px solid var(--dispatch-border)",
              background: "transparent",
              color: page >= totalPages - 1 ? "var(--dispatch-text-tertiary)" : "var(--dispatch-text-secondary)",
              fontSize: 13,
              cursor: page >= totalPages - 1 ? "not-allowed" : "pointer",
            }}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
