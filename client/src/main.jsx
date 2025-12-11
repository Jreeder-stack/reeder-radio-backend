import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import Login from "./Login.jsx";
import App from "./App.jsx";
import Dispatcher from "./Dispatcher.jsx";
import Admin from "./Admin.jsx";
import DispatchConsole from "./pages/DispatchConsole.jsx";
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
  return <App user={user} onLogout={logout} />;
}

function DispatcherWrapper() {
  const { user, logout } = useAuth();
  return <Dispatcher user={user} onLogout={logout} />;
}

function DispatchConsoleWrapper() {
  const { user, logout } = useAuth();
  return <DispatchConsole user={user} onLogout={logout} />;
}

function AdminWrapper() {
  const { user, logout } = useAuth();
  return <Admin user={user} onLogout={logout} />;
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
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
            path="/dispatcher-legacy"
            element={
              <ProtectedRoute dispatcherOnly>
                <DispatcherWrapper />
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
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
