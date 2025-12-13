import { useState } from "react";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);

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
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <div
        style={{
          background: "#1e1e2e",
          borderRadius: 16,
          padding: 40,
          width: 360,
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{ marginBottom: 10, display: "flex", justifyContent: "center" }}>
            <svg
              width="64"
              height="64"
              viewBox="0 0 100 100"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Signal waves */}
              <path
                d="M30 25 C30 25, 35 15, 50 15 C65 15, 70 25, 70 25"
                stroke="#3b82f6"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M22 32 C22 32, 30 18, 50 18 C70 18, 78 32, 78 32"
                stroke="#3b82f6"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
              />
              <path
                d="M14 40 C14 40, 25 22, 50 22 C75 22, 86 40, 86 40"
                stroke="#3b82f6"
                strokeWidth="4"
                strokeLinecap="round"
                fill="none"
              />
              {/* Tower head */}
              <circle cx="50" cy="30" r="5" fill="#3b82f6" />
              {/* Tower body */}
              <path
                d="M50 35 L50 45 M42 95 L50 45 L58 95"
                stroke="#3b82f6"
                strokeWidth="4"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
              />
              {/* Tower cross beams */}
              <path
                d="M44 55 L56 55 M45 65 L55 65 M46 75 L54 75 M47 85 L53 85"
                stroke="#3b82f6"
                strokeWidth="3"
                strokeLinecap="round"
                fill="none"
              />
              {/* Tower diagonal beams */}
              <path
                d="M44 55 L55 65 M56 55 L45 65 M45 65 L54 75 M55 65 L46 75 M46 75 L53 85 M54 75 L47 85"
                stroke="#3b82f6"
                strokeWidth="2"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </div>
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
          Command Communications by Reeder - Systems
        </div>
      </div>
    </div>
  );
}
