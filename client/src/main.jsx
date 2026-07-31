import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import { AudioConnectionProvider, useAudioConnection } from "./context/AudioConnectionContext.jsx";
import { SignalingProvider } from "./context/SignalingContext.jsx";
import { MobileRadioProvider } from "./context/MobileRadioContext.jsx";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import { GlobalEmergencyOverlay } from "./components/EmergencyPanel/index.jsx";
import { ThemeProvider } from "./context/ThemeContext.jsx";
import Login from "./Login.jsx";
import App from "./App.jsx";
import Admin from "./Admin.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
import DispatcherMap from "./pages/DispatcherMap.jsx";
import RadioApp from "./pages/RadioApp.jsx";
import RecordingLogsPage from "./pages/RecordingLogsPage.jsx";
import RadioManagement from "./pages/RadioManagement.jsx";
import DispatchCenterAssignments from "./pages/DispatchCenterAssignments.jsx";
import AIDispatcherProfiles from "./pages/AIDispatcherProfiles.jsx";
import VmLogs from "./VmLogs.jsx";
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
        className="min-h-screen-safe"
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--dispatch-bg)",
          color: "var(--dispatch-text)",
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
  const { user, loading, login, sessionConflict, clearSessionConflict } = useAuth();
  const isMobile = useMobile();

  if (loading) {
    return (
      <div
        className="min-h-screen-safe"
        style={{
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--dispatch-bg)",
          color: "var(--dispatch-text)",
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
    return <MobileLogin onLogin={login} sessionConflict={sessionConflict} clearSessionConflict={clearSessionConflict} />;
  }

  return <Login onLogin={login} sessionConflict={sessionConflict} clearSessionConflict={clearSessionConflict} />;
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
  
  return (
    <>
      <Admin user={user} onLogout={handleLogout} />
      <button
        type="button"
        onClick={() => window.location.assign('/admin/ai-dispatchers')}
        style={{
          position: 'fixed',
          right: 20,
          bottom: 72,
          zIndex: 1000,
          border: '1px solid var(--dispatch-accent)',
          borderRadius: 10,
          padding: '10px 14px',
          background: 'var(--dispatch-panel)',
          color: 'var(--dispatch-text)',
          fontWeight: 700,
          cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(0,0,0,.3)',
        }}
      >
        AI Dispatcher Profiles
      </button>
      <button
        type="button"
        onClick={() => window.location.assign('/admin/dispatch-centers')}
        style={{
          position: 'fixed',
          right: 20,
          bottom: 20,
          zIndex: 1000,
          border: '1px solid var(--dispatch-accent)',
          borderRadius: 10,
          padding: '10px 14px',
          background: 'var(--dispatch-panel)',
          color: 'var(--dispatch-text)',
          fontWeight: 700,
          cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(0,0,0,.3)',
        }}
      >
        Dispatch Center Assignments
      </button>
    </>
  );
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

function RadioManagementWrapper() {
  const { user } = useAuth();
  return <RadioManagement user={user} />;
}

function VmLogsWrapper() {
  return <VmLogs standalone />;
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
              path="/admin/dispatch-centers"
              element={
                <ProtectedRoute adminOnly>
                  <DispatchCenterAssignments />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/ai-dispatchers"
              element={
                <ProtectedRoute adminOnly>
                  <AIDispatcherProfiles />
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
            <Route
              path="/radios"
              element={
                <ProtectedRoute dispatcherOnly>
                  <RadioManagementWrapper />
                </ProtectedRoute>
              }
            />
            <Route
              path="/vm-logs"
              element={
                <ProtectedRoute adminOnly>
                  <VmLogsWrapper />
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

// Remove the inline boot splash once React takes over, so we don't show the
// app behind a frozen splash. Kept until the first paint to mask the white
// flash on iOS PWA cold-start.
const __bootSplash = document.getElementById('__boot_splash');
if (__bootSplash) {
  requestAnimationFrame(() => {
    __bootSplash.style.transition = 'opacity 200ms ease';
    __bootSplash.style.opacity = '0';
    setTimeout(() => __bootSplash.remove(), 250);
  });
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ThemeProvider>
          <AuthProvider>
            <ConnectedRoutes />
          </AuthProvider>
        </ThemeProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
