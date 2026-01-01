import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import { LiveKitConnectionProvider, useLiveKitConnection } from "./context/LiveKitConnectionContext.jsx";
import Login from "./Login.jsx";
import App from "./App.jsx";
import Admin from "./Admin.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
import DispatcherMap from "./pages/DispatcherMap.jsx";
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

  return <Login onLogin={login} />;
}

function AppWrapper() {
  const { user, logout } = useAuth();
  const { disconnectAll } = useLiveKitConnection();
  
  const handleLogout = async () => {
    await disconnectAll();
    logout();
  };
  
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

function ConnectedRoutes() {
  const { user } = useAuth();
  
  return (
    <LiveKitConnectionProvider user={user}>
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
      </Routes>
    </LiveKitConnectionProvider>
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
