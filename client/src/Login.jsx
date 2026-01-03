import { useState } from "react";
import { unlockAudio } from "./audio/iosAudioUnlock";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

    unlockAudio();

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Authentication failed");
        return;
      }

      onLogin(data.user);
    } catch (err) {
      setError("Connection error. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        minHeight: "100dvh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: "16px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          background: "#1e1e2e",
          borderRadius: 16,
          padding: "clamp(24px, 5vw, 40px)",
          width: "100%",
          maxWidth: 360,
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <h1
            style={{
              color: "#fff",
              margin: 0,
              fontSize: 22,
              fontWeight: 600,
            }}
          >
            Command Communications
          </h1>
          <p style={{ color: "#666", margin: "4px 0 0", fontSize: 11 }}>
            by Reeder - Systems
          </p>
          <p style={{ color: "#888", margin: "8px 0 0", fontSize: 14 }}>
            Sign in to continue
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 20 }}>
            <label
              style={{
                display: "block",
                color: "#aaa",
                marginBottom: 8,
                fontSize: 14,
              }}
            >
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter username"
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: "1px solid #333",
                background: "#2a2a3e",
                color: "#fff",
                fontSize: 16,
                boxSizing: "border-box",
                outline: "none",
              }}
              required
            />
          </div>

          <div style={{ marginBottom: 24 }}>
            <label
              style={{
                display: "block",
                color: "#aaa",
                marginBottom: 8,
                fontSize: 14,
              }}
            >
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              style={{
                width: "100%",
                padding: "12px 16px",
                borderRadius: 8,
                border: "1px solid #333",
                background: "#2a2a3e",
                color: "#fff",
                fontSize: 16,
                boxSizing: "border-box",
                outline: "none",
              }}
              required
            />
          </div>

          {error && (
            <div
              style={{
                background: "#dc2626",
                color: "#fff",
                padding: "10px 14px",
                borderRadius: 8,
                marginBottom: 20,
                fontSize: 14,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              padding: "14px",
              borderRadius: 8,
              border: "none",
              background: loading ? "#555" : "#3b82f6",
              color: "#fff",
              fontSize: 16,
              fontWeight: 600,
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background 0.2s",
            }}
          >
            {loading ? "Please wait..." : "Sign In"}
          </button>
        </form>

        <div
          style={{
            marginTop: 30,
            paddingTop: 20,
            borderTop: "1px solid #333",
            textAlign: "center",
            color: "#666",
            fontSize: 12,
          }}
        >
          Access by approved personnel only
        </div>
      </div>
    </div>
  );
}
