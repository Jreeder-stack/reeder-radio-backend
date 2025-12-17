import { createContext, useContext, useState, useEffect, useCallback } from "react";
import useDispatchStore from "./state/dispatchStore";

const AuthContext = createContext(null);

const AUTH_CACHE_KEY = 'auth_user_cache';

function getCachedUser() {
  try {
    const cached = sessionStorage.getItem(AUTH_CACHE_KEY);
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

function setCachedUser(user) {
  try {
    if (user) {
      sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
    } else {
      sessionStorage.removeItem(AUTH_CACHE_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

export function AuthProvider({ children }) {
  const cachedUser = getCachedUser();
  const [user, setUser] = useState(cachedUser);
  const [loading, setLoading] = useState(!cachedUser);

  const checkAuth = useCallback(async (isBackgroundCheck = false) => {
    if (!isBackgroundCheck) {
      setLoading(true);
    }
    
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
        setCachedUser(data.user);
      } else {
        setUser(null);
        setCachedUser(null);
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      if (!isBackgroundCheck) {
        setUser(null);
        setCachedUser(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (cachedUser) {
      checkAuth(true);
    } else {
      checkAuth(false);
    }
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && user) {
        checkAuth(true);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user, checkAuth]);

  const login = (userData) => {
    setUser(userData);
    setCachedUser(userData);
  };

  const logout = async () => {
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
      });
    } catch (err) {
      console.error("Logout error:", err);
    }
    
    useDispatchStore.getState().resetStore();
    localStorage.removeItem('dispatch-channels');
    setCachedUser(null);
    
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
}
