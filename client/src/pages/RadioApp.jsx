import { useNavigate } from "react-router-dom";

export default function RadioApp({ user, onLogout }) {
  const navigate = useNavigate();

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#1a1a2e",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
    >
      <div
        style={{
          background: "#2a2a4a",
          padding: 40,
          borderRadius: 16,
          textAlign: "center",
          maxWidth: 400,
        }}
      >
        <h1 style={{ marginBottom: 16, fontSize: 24 }}>Radio App</h1>
        <p style={{ color: "#888", marginBottom: 24 }}>
          Android Radio Application
        </p>
        <p style={{ color: "#666", fontSize: 14, marginBottom: 32 }}>
          This page will host the native Android radio application login.
        </p>
        <button
          onClick={() => navigate("/admin")}
          style={{
            padding: "12px 24px",
            background: "#3b82f6",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          Back to Admin
        </button>
      </div>
    </div>
  );
}
