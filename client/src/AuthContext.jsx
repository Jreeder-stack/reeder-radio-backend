import { createContext, useContext, useState, useEffect, useCallback } from "react";
import useDispatchStore from "./state/dispatchStore";
import { updateServiceConnectionInfo } from "./plugins/nativeLiveKit";

const AuthContext = createContext(null);

const AUTH_CACHE_KEY = 'auth_user_cache';
var AUTO_LOGIN_KEY = 'auto_login_creds';

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

function obfuscate(str) {
  try { return btoa(encodeURIComponent(str)); } catch(e) { return str; }
}
function deobfuscate(str) {
  try { return decodeURIComponent(atob(str)); } catch(e) { return str; }
}

function saveAutoLoginCreds(username, password) {
  try {
    localStorage.setItem(AUTO_LOGIN_KEY, JSON.stringify({ u: obfuscate(username), p: obfuscate(password) }));
    localStorage.removeItem('auto_login_failures');
  } catch(e) {
  }
}

function getAutoLoginCreds() {
  try {
    var failures = parseInt(localStorage.getItem('auto_login_failures') || '0', 10);
    if (failures >= 3) {
      clearAutoLoginCreds();
      return null;
    }
    var saved = localStorage.getItem(AUTO_LOGIN_KEY);
    if (!saved) return null;
    var parsed = JSON.parse(saved);
    return { u: deobfuscate(parsed.u), p: deobfuscate(parsed.p) };
  } catch(e) {
    return null;
  }
}

function clearAutoLoginCreds() {
  try {
    localStorage.removeItem(AUTO_LOGIN_KEY);
  } catch(e) {
  }
}

async function tryAutoLogin() {
  var creds = getAutoLoginCreds();
  if (!creds || !creds.u || !creds.p) return null;
  try {
    var res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: creds.u, password: creds.p }),
    });
    if (res.ok) {
      var data = await res.json();
      if (data.user) {
        try { localStorage.removeItem('auto_login_failures'); } catch(e3) {}
        return data.user;
      }
    }
  } catch(e) {
    console.error('[AutoLogin] Failed:', e);
  }
  try {
    var prev = parseInt(localStorage.getItem('auto_login_failures') || '0', 10);
    localStorage.setItem('auto_login_failures', String(prev + 1));
  } catch(e2) {}
  return null;
}

export function AuthProvider({ children }) {
  const cachedUser = getCachedUser();
  const [user, setUser] = useState(cachedUser);
  // Always start loading regardless of cached user — the session must be verified
  // with the server before the app renders and starts making authenticated requests
  // (e.g. /getToken). Without this, a stale cache causes /getToken 401s.
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
        var autoUser = await tryAutoLogin();
        if (autoUser) {
          console.log('[AutoLogin] Re-authenticated successfully');
          setUser(autoUser);
          setCachedUser(autoUser);
        } else {
          setUser(null);
          setCachedUser(null);
        }
      }
    } catch (err) {
      console.error("Auth check failed:", err);
      if (!isBackgroundCheck) {
        var fallbackUser = await tryAutoLogin();
        if (fallbackUser) {
          setUser(fallbackUser);
          setCachedUser(fallbackUser);
        } else {
          setUser(null);
          setCachedUser(null);
        }
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Always run a foreground check so loading stays true until the server confirms
    // the session is valid. Auto-login handles re-auth transparently if needed.
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

  const login = (userData, credentials) => {
    setUser(userData);
    setCachedUser(userData);
    if (credentials && credentials.username && credentials.password) {
      saveAutoLoginCreds(credentials.username, credentials.password);
    }
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
    clearAutoLoginCreds();
    
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
