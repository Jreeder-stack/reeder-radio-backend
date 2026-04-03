import { useState, useEffect, useRef, useCallback } from "react";

export default function VmLogs({ isMobile }) {
  const [source, setSource] = useState("server");
  const [lines, setLines] = useState([]);
  const [paused, setPaused] = useState(false);
  const [connected, setConnected] = useState(false);
  const containerRef = useRef(null);
  const autoScrollRef = useRef(true);
  const pausedRef = useRef(false);
  const bufferRef = useRef([]);
  const eventSourceRef = useRef(null);
  const MAX_LINES = 2000;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  const flushBuffer = useCallback(() => {
    if (pausedRef.current) return;
    if (bufferRef.current.length > 0) {
      const batch = bufferRef.current.splice(0);
      setLines((prev) => {
        const next = [...prev, ...batch];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(flushBuffer, 200);
    return () => clearInterval(interval);
  }, [flushBuffer]);

  useEffect(() => {
    setLines([]);
    bufferRef.current = [];
    autoScrollRef.current = true;
    setPaused(false);

    const es = new EventSource(`/api/admin/vm-logs?source=${source}`, { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        bufferRef.current.push(data);
      } catch (_) {}
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setConnected(false);
    };
  }, [source]);

  useEffect(() => {
    if (autoScrollRef.current && !pausedRef.current && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  const togglePause = () => {
    const next = !paused;
    pausedRef.current = next;
    setPaused(next);
    if (!next) {
      autoScrollRef.current = true;
      flushBuffer();
      requestAnimationFrame(() => {
        if (containerRef.current) {
          containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }
      });
    }
  };

  const clearLogs = () => {
    setLines([]);
    bufferRef.current = [];
  };

  const formatTimestamp = (ts) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  };

  const btnStyle = (active) => ({
    padding: isMobile ? "6px 12px" : "6px 16px",
    border: "1px solid #444",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
    background: active ? "#3b82f6" : "#1e1e2e",
    color: active ? "#fff" : "#aaa",
    transition: "all 0.15s",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 180px)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{
            width: 8, height: 8, borderRadius: "50%",
            background: connected ? "#22c55e" : "#ef4444",
            display: "inline-block",
            marginRight: 4,
          }} />
          <span style={{ fontSize: 13, color: "#888" }}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={btnStyle(source === "server")} onClick={() => setSource("server")}>
            Server Logs
          </button>
          <button style={btnStyle(source === "system")} onClick={() => setSource("system")}>
            System Logs
          </button>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={btnStyle(paused)} onClick={togglePause}>
            {paused ? "▶ Resume" : "⏸ Freeze"}
          </button>
          <button style={btnStyle(false)} onClick={clearLogs}>
            Clear
          </button>
        </div>
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          background: "#0d1117",
          border: "1px solid #333",
          borderRadius: 8,
          padding: 12,
          overflowY: "auto",
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: isMobile ? 11 : 13,
          lineHeight: 1.6,
          color: "#c9d1d9",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {lines.length === 0 && (
          <div style={{ color: "#555", textAlign: "center", padding: 40 }}>
            Waiting for log output...
          </div>
        )}
        {lines.map((entry, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            <span style={{ color: "#555" }}>{formatTimestamp(entry.ts)}</span>{" "}
            <span>{entry.line}</span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 11, color: "#555", marginTop: 6, textAlign: "right" }}>
        {lines.length} lines {paused ? "(paused)" : ""}
      </div>
    </div>
  );
}
