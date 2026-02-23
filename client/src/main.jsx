import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import { LiveKitConnectionProvider, useLiveKitConnection } from "./context/LiveKitConnectionContext.jsx";
import { SignalingProvider } from "./context/SignalingContext.jsx";
import { MobileRadioProvider } from "./context/MobileRadioContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import Login from "./Login.jsx";
import App from "./App.jsx";
import Admin from "./Admin.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
import DispatcherMap from "./pages/DispatcherMap.jsx";
import RadioApp from "./pages/RadioApp.jsx";
import { RadioDeckView } from "./components/MobileRadio/RadioDeckView.jsx";
import { MobileLogin } from "./components/MobileRadio/MobileLogin.jsx";
import { MobileSettings } from "./components/MobileRadio/MobileSettings.jsx";
import { MobileScanMonitor } from "./components/MobileRadio/MobileScanMonitor.jsx";
import { useMobile } from "./hooks/useMobile.js";
import "./index.css";

const isCapacitorNative = typeof window !== 'undefined' && 
  window.Capacitor?.isNativePlatform?.() === true;

if (isCapacitorNative && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((reg) => {
      reg.unregister();
      console.log('[Capacitor] Unregistered service worker');
    });
  });
  if ('caches' in window) {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
      if (names.length > 0) console.log('[Capacitor] Cleared', names.length, 'caches');
    });
  }
}

window.__APP_BOOT = { start: Date.now(), steps: [] };
window.__APP_BOOT.steps.push('module_loaded');
window.addEventListener('error', (e) => {
  console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason);
});

function CapacitorDiagOverlay() {
  const [visible, setVisible] = useState(isCapacitorNative);
  const [info, setInfo] = useState('');
  
  useEffect(() => {
    if (!isCapacitorNative) return;
    const lines = [
      `Platform: Capacitor Native`,
      `Origin: ${window.location.origin}`,
      `Boot: ${window.__APP_BOOT?.steps?.join(' > ') || 'unknown'}`,
      `UA: ${navigator.userAgent?.substring(0, 60)}`,
    ];
    setInfo(lines.join('\n'));
    const timer = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(timer);
  }, []);
  
  if (!visible) return null;
  
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
      background: 'rgba(0,0,0,0.85)', color: '#0f0', fontSize: '10px',
      fontFamily: 'monospace', padding: '8px', whiteSpace: 'pre-wrap',
    }} onClick={() => setVisible(false)}>
      {info}
      <div style={{ color: '#888', marginTop: '4px' }}>tap to dismiss</div>
    </div>
  );
}

function ProtectedRoute({ children, adminOnly = false, dispatcherOnly = false }) {
  const { user, loading } = useAuth();

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
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        Loading...
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (adminOnly && user.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  if (dispatcherOnly && !user.is_dispatcher && user.role !== "admin") {
    return <Navigate to="/" replace />;
  }

  return children;
}

function LoginRoute() {
  const { user, loading, login } = useAuth();
  const isMobile = useMobile();

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
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
        Loading...
      </div>
    );
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  if (isMobile) {
    return <MobileLogin onLogin={login} />;
  }

  return <Login onLogin={login} />;
}

function AppWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useLiveKitConnection();
  const isMobile = useMobile();
  
  useEffect(() => {
    localStorage.removeItem('interface_mode');
  }, []);
  
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    return saved !== null ? JSON.parse(saved) : true;
  });
  
  const toggleDarkMode = () => {
    setDarkMode(prev => {
      const next = !prev;
      localStorage.setItem('darkMode', JSON.stringify(next));
      return next;
    });
  };
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  if (isMobile) {
    return (
      <RadioDeckView 
        user={user} 
        onLogout={handleLogout}
      />
    );
  }
  
  return <App user={user} onLogout={handleLogout} />;
}

function DispatchConsoleWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useLiveKitConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <DispatchConsole user={user} onLogout={handleLogout} />;
}

function AdminWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useLiveKitConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <Admin user={user} onLogout={handleLogout} />;
}

function RadioAppWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useLiveKitConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <RadioApp user={user} onLogout={handleLogout} />;
}

function MobileSettingsWrapper() {
  const { logout } = useAuth();
  const { disconnectAll } = useLiveKitConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <MobileSettings onLogout={handleLogout} />;
}

function ConnectedRoutes() {
  const { user } = useAuth();
  
  return (
    <SignalingProvider>
      <LiveKitConnectionProvider user={user}>
        <MobileRadioProvider>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <AppWrapper />
                </ProtectedRoute>
              }
            />
            <Route
              path="/settings"
              element={
                <ProtectedRoute>
                  <MobileSettingsWrapper />
                </ProtectedRoute>
              }
            />
            <Route
              path="/scan"
              element={
                <ProtectedRoute>
                  <MobileScanMonitor />
                </ProtectedRoute>
              }
            />
            <Route
              path="/dispatcher"
              element={
                <ProtectedRoute dispatcherOnly>
                  <DispatchConsoleWrapper />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute adminOnly>
                  <AdminWrapper />
                </ProtectedRoute>
              }
            />
            <Route
              path="/map"
              element={
                <ProtectedRoute dispatcherOnly>
                  <DispatcherMap />
                </ProtectedRoute>
              }
            />
            <Route
              path="/radio-app"
              element={
                <ProtectedRoute adminOnly>
                  <RadioAppWrapper />
                </ProtectedRoute>
              }
            />
          </Routes>
        </MobileRadioProvider>
      </LiveKitConnectionProvider>
    </SignalingProvider>
  );
}

window.__APP_BOOT.steps.push('rendering');

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <CapacitorDiagOverlay />
      <BrowserRouter>
        <AuthProvider>
          <ConnectedRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
