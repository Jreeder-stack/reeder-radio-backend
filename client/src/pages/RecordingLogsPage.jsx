import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import RecordingLogs from "../RecordingLogs.jsx";
import { useTheme } from "../context/ThemeContext.jsx";

export default function RecordingLogsPage({ user, onLogout }) {
  const navigate = useNavigate();
  const { darkMode, toggleDarkMode } = useTheme();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return (
    <div
      className="min-h-screen-safe"
      style={{
        background: "var(--dispatch-bg)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        color: "var(--dispatch-text)",
        overflowY: "auto",
      }}
    >
      <header
        style={{
          background: "var(--dispatch-panel)",
          padding: isMobile ? "12px 16px" : "16px 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid var(--dispatch-border)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24 }}>🎙️</span>
          <h1 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 600, color: "var(--dispatch-text)" }}>
            Recording Logs
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            onClick={toggleDarkMode}
            title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
            style={{
              padding: "8px 12px",
              background: "transparent",
              color: "var(--dispatch-text-secondary)",
              border: "1px solid var(--dispatch-border)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            {darkMode ? "☀️" : "🌙"}
          </button>
          <button
            onClick={() => navigate(-1)}
            style={{
              padding: "8px 16px",
              background: "var(--dispatch-panel-elevated)",
              color: "var(--dispatch-text)",
              border: "1px solid var(--dispatch-border)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 14,
            }}
          >
            Back
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

      <div style={{ padding: isMobile ? 12 : 24 }}>
        <RecordingLogs isMobile={isMobile} />
      </div>
    </div>
  );
}
