import React, { useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import { LiveKitConnectionProvider, useLiveKitConnection } from "./context/LiveKitConnectionContext.jsx";
import { SignalingProvider } from "./context/SignalingContext.jsx";
import { MobileRadioProvider } from "./context/MobileRadioContext.jsx";
import Login from "./Login.jsx";
import App from "./App.jsx";
import Admin from "./Admin.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
import DispatcherMap from "./pages/DispatcherMap.jsx";
import RadioApp from "./pages/RadioApp.jsx";
import MobileRadioView from "./components/MobileRadio/index.jsx";
import { MobileLogin } from "./components/MobileRadio/MobileLogin.jsx";
import { MobileSettings } from "./components/MobileRadio/MobileSettings.jsx";
import { MobileScanMonitor } from "./components/MobileRadio/MobileScanMonitor.jsx";
import { useMobile } from "./hooks/useMobile.js";
import "./index.css";

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
      <MobileRadioView 
        user={user} 
        onLogout={handleLogout} 
        darkMode={darkMode}
        toggleDarkMode={toggleDarkMode}
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

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ConnectedRoutes />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
