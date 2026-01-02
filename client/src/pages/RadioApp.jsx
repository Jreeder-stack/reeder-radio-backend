import { useNavigate } from "react-router-dom";

export default function RadioApp({ user, onLogout }) {
  const navigate = useNavigate();

  const cardStyle = {
    background: "#2a2a4a",
    padding: 20,
    borderRadius: 12,
    marginBottom: 16,
  };

  const labelStyle = {
    color: "#888",
    fontSize: 12,
    marginBottom: 4,
    display: "block",
  };

  const valueStyle = {
    color: "#fff",
    fontSize: 14,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#1a1a2e",
        color: "#fff",
        fontFamily: "system-ui, -apple-system, sans-serif",
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h1 style={{ fontSize: 24, margin: 0 }}>Radio App</h1>
          <button
            onClick={() => navigate("/admin")}
            style={{
              padding: "8px 16px",
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

        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, marginBottom: 16, color: "#10b981" }}>Android App Development</h2>
          <p style={{ color: "#aaa", fontSize: 14, lineHeight: 1.6 }}>
            The Android radio app source code is located in the <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>android-app/</code> folder.
            It uses Capacitor to wrap the web UI into a native Android application with hardware PTT support.
          </p>
        </div>

        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>App Details</h2>
          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>App ID</span>
            <span style={valueStyle}>com.reedersystems.commandcomms</span>
          </div>
          <div style={{ marginBottom: 12 }}>
            <span style={labelStyle}>App Name</span>
            <span style={valueStyle}>COMMAND COMMS</span>
          </div>
          <div>
            <span style={labelStyle}>Backend</span>
            <span style={valueStyle}>Uses this server for authentication and LiveKit</span>
          </div>
        </div>

        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Build Instructions</h2>
          <ol style={{ color: "#aaa", fontSize: 14, lineHeight: 2, paddingLeft: 20, margin: 0 }}>
            <li>Install dependencies: <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>cd android-app && npm install</code></li>
            <li>Build the web app: <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>npm run build</code></li>
            <li>Add Android platform: <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>npx cap add android</code></li>
            <li>Sync with Capacitor: <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>npx cap sync android</code></li>
            <li>Copy native plugins from <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>android-config/</code></li>
            <li>Open in Android Studio: <code style={{ background: "#1a1a2e", padding: "2px 6px", borderRadius: 4 }}>npx cap open android</code></li>
            <li>Build APK from Android Studio</li>
          </ol>
        </div>

        <div style={cardStyle}>
          <h2 style={{ fontSize: 18, marginBottom: 16 }}>Native Plugins</h2>
          <ul style={{ color: "#aaa", fontSize: 14, lineHeight: 1.8, paddingLeft: 20, margin: 0 }}>
            <li><strong style={{ color: "#fff" }}>LiveKitPlugin.kt</strong> - Native LiveKit SDK for reliable PTT audio</li>
            <li><strong style={{ color: "#fff" }}>HardwarePttPlugin.java</strong> - Volume/Bluetooth PTT key support</li>
            <li><strong style={{ color: "#fff" }}>BackgroundAudioService.java</strong> - Background audio and GPS service</li>
            <li><strong style={{ color: "#fff" }}>DndOverridePlugin.java</strong> - Do Not Disturb override for alerts</li>
          </ul>
        </div>

        <div style={{ ...cardStyle, background: "#1e3a5f", borderLeft: "4px solid #3b82f6" }}>
          <h2 style={{ fontSize: 16, marginBottom: 8, color: "#60a5fa" }}>Play Store Release</h2>
          <p style={{ color: "#94a3b8", fontSize: 14, margin: 0, lineHeight: 1.6 }}>
            When ready for production, build a signed APK/AAB in Android Studio and upload to Google Play Console.
            The app will launch directly to the radio login screen.
          </p>
        </div>
      </div>
    </div>
  );
}
