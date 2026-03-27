import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import RecordingLogs from "../RecordingLogs.jsx";

export default function RecordingLogsPage({ user, onLogout }) {
  const navigate = useNavigate();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

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
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #333",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 24 }}>🎙️</span>
          <h1 style={{ margin: 0, fontSize: isMobile ? 18 : 20, fontWeight: 600 }}>
            Recording Logs
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => navigate(-1)}
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
