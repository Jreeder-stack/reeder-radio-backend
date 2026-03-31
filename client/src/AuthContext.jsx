import { createContext, useContext, useState, useEffect, useCallback } from "react";
import useDispatchStore from "./state/dispatchStore";
import { updateServiceConnectionInfo } from "./plugins/nativeAudioBridge";

const AuthContext = createContext(null);

const AUTH_CACHE_KEY = 'auth_user_cache';

function getCachedUser() {
  try {
    var cached = localStorage.getItem(AUTH_CACHE_KEY);
    if (cached) return JSON.parse(cached);
    cached = sessionStorage.getItem(AUTH_CACHE_KEY);
    return cached ? JSON.parse(cached) : null;
  } catch(e) {
    return null;
  }
}

function setCachedUser(user) {
  try {
    if (user) {
      localStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
      sessionStorage.setItem(AUTH_CACHE_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(AUTH_CACHE_KEY);
      sessionStorage.removeItem(AUTH_CACHE_KEY);
    }
  } catch(e) {
  }
}

export function AuthProvider({ children }) {
  const cachedUser = getCachedUser();
  const [user, setUser] = useState(cachedUser);
  // Always start loading regardless of cached user — the session must be verified
  // with the server before the app renders and starts making authenticated requests
  // Without this, a stale cache causes authenticated API request 401s.
  const [loading, setLoading] = useState(true);

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
    checkAuth(false);
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

  useEffect(() => {
    if (user && user.username) {
      try {
        const serverBaseUrl = window.location.origin;
        updateServiceConnectionInfo(serverBaseUrl, user.username, '', '', '');
        console.log('[PTT-DIAG] [JS] Auth: pushed early connection info to service: server=' + serverBaseUrl + ' unit=' + user.username);
      } catch (e) {
        console.warn('[PTT-DIAG] [JS] Auth: failed to push early connection info:', e);
      }
    }
  }, [user]);

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
