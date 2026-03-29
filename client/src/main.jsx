import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import { AudioConnectionProvider, useAudioConnection } from "./context/AudioConnectionContext.jsx";
import { SignalingProvider } from "./context/SignalingContext.jsx";
import { MobileRadioProvider } from "./context/MobileRadioContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { GlobalEmergencyOverlay } from "./components/EmergencyPanel/index.jsx";
import Login from "./Login.jsx";
import App from "./App.jsx";
import Admin from "./Admin.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
import DispatcherMap from "./pages/DispatcherMap.jsx";
import RadioApp from "./pages/RadioApp.jsx";
import RecordingLogsPage from "./pages/RecordingLogsPage.jsx";
import { RadioDeckView } from "./components/MobileRadio/RadioDeckView.jsx";
import { MobileLogin } from "./components/MobileRadio/MobileLogin.jsx";
import { MobileSettings } from "./components/MobileRadio/MobileSettings.jsx";
import { MobileScanMonitor } from "./components/MobileRadio/MobileScanMonitor.jsx";
import { useMobile } from "./hooks/useMobile.js";
import { isNative } from "./lib/capacitor.js";
import "./index.css";

console.log(`[BUILD] client version=${typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev'} built=${typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'}`);

window.__APP_BOOT = { start: Date.now(), steps: [] };
window.__APP_BOOT.steps.push('module_loaded');
window.addEventListener('error', (e) => {
  console.error('[GLOBAL ERROR]', e.message, e.filename, e.lineno);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[UNHANDLED REJECTION]', e.reason);
});

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
  const { disconnectAll } = useAudioConnection();
  const isMobile = useMobile();
  
  useEffect(() => {
    localStorage.removeItem('interface_mode');
  }, []);

  useEffect(() => {
    if (isNative && user) {
      console.log('[AppWrapper] Native platform detected; native startup is handled by android-native app lifecycle.');
    }
  }, [user]);
  
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

  if (user && (user.is_dispatcher || user.role === 'admin') && !isMobile) {
    return <Navigate to="/dispatcher" replace />;
  }
  
  return <App user={user} onLogout={handleLogout} />;
}

function DispatchConsoleWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useAudioConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <DispatchConsole user={user} onLogout={handleLogout} />;
}

function AdminWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useAudioConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <Admin user={user} onLogout={handleLogout} />;
}

function RadioAppWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useAudioConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <RadioApp user={user} onLogout={handleLogout} />;
}

function RecordingLogsWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useAudioConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <RecordingLogsPage user={user} onLogout={handleLogout} />;
}

function MobileSettingsWrapper() {
  const { logout } = useAuth();
  const { disconnectAll } = useAudioConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
  return <MobileSettings onLogout={handleLogout} />;
}

function ConnectedRoutes() {
  const { user, loading } = useAuth();

  return (
    <SignalingProvider>
      <AudioConnectionProvider user={loading ? null : user}>
        <MobileRadioProvider>
          <GlobalEmergencyOverlay />
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
            <Route
              path="/recording-logs"
              element={
                <ProtectedRoute dispatcherOnly>
                  <RecordingLogsWrapper />
                </ProtectedRoute>
              }
            />
          </Routes>
        </MobileRadioProvider>
      </AudioConnectionProvider>
    </SignalingProvider>
  );
}

window.__APP_BOOT.steps.push('rendering');

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AuthProvider>
          <ConnectedRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
