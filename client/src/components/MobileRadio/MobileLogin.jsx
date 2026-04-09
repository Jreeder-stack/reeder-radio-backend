import { useState, useEffect, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { MobileFrame } from "./MobileFrame";
import { Shield, Lock, ArrowRight, Radio, AlertCircle } from "lucide-react";

function checkIsT320() {
  if (typeof window === 'undefined') return false;
  var iw = window.innerWidth || 0;
  var sw = window.screen ? window.screen.width : 0;
  var isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  if (iw <= 280 || sw <= 280) return true;
  if (isCapacitor && (iw <= 480 || sw <= 480)) return true;
  return false;
}

function useIsT320() {
  var val = useSyncExternalStore(
    function(cb) { window.addEventListener('resize', cb); return function() { window.removeEventListener('resize', cb); }; },
    checkIsT320,
    function() { return false; }
  );
  return val;
}

export function MobileLogin({ onLogin, sessionConflict, clearSessionConflict }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();
  const isT320 = useIsT320();

  useEffect(() => {
    if (sessionConflict && clearSessionConflict) {
      const timer = setTimeout(() => clearSessionConflict(), 10000);
      return () => clearTimeout(timer);
    }
  }, [sessionConflict, clearSessionConflict]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });
      
      const data = await response.json();
      
      if (response.ok && data.user) {
        onLogin(data.user, { username: username, password: password });
        navigate('/');
      } else {
        setError(data.message || "Login failed");
      }
    } catch (err) {
      setError("Network error - please try again");
    } finally {
      setIsLoading(false);
    }
  };

  if (isT320) {
    var accent = '#0077aa';
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: '#ffffff',
        color: '#111111',
        fontFamily: "'Courier New', Courier, monospace",
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        userSelect: 'none',
        WebkitUserSelect: 'none',
      }}>
        <div style={{
          display: 'flex', flexDirection: 'column',
          height: '100%',
          padding: '6px 8px',
          justifyContent: 'center',
        }}>
          <div style={{ textAlign: 'center', marginBottom: '8px' }}>
            <div style={{
              color: accent,
              fontSize: '14px',
              fontWeight: 'bold',
              letterSpacing: '1px',
              lineHeight: '1.2',
            }}>
              COMMAND
            </div>
            <div style={{
              color: '#111111',
              fontSize: '14px',
              fontWeight: 'bold',
              letterSpacing: '1px',
              lineHeight: '1.2',
            }}>
              COMMS
            </div>
            <div style={{
              color: '#888888',
              fontSize: '8px',
              letterSpacing: '2px',
              marginTop: '2px',
            }}>
              REEDER SYSTEMS
            </div>
          </div>

          {sessionConflict && (
            <div style={{
              backgroundColor: '#fff7ed',
              border: '1px solid #d97706',
              color: '#92400e',
              fontSize: '9px',
              padding: '3px 6px',
              marginBottom: '4px',
              textAlign: 'center',
            }}>
              Session used by another account. Sign in again.
            </div>
          )}

          {error && (
            <div style={{
              backgroundColor: '#fff0f0',
              border: '1px solid #cc0000',
              color: '#cc0000',
              fontSize: '9px',
              padding: '3px 6px',
              marginBottom: '4px',
              textAlign: 'center',
            }}>
              {error}
            </div>
          )}

          <form onSubmit={handleLogin}>
            <div style={{ marginBottom: '4px' }}>
              <div style={{
                color: '#555555',
                fontSize: '9px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                marginBottom: '1px',
              }}>
                UNIT ID
              </div>
              <input
                type="text"
                value={username}
                onChange={function(e) { setUsername(e.target.value); }}
                style={{
                  width: '100%',
                  backgroundColor: '#f5f5f5',
                  border: '2px solid #cccccc',
                  color: '#111111',
                  fontFamily: "'Courier New', Courier, monospace",
                  fontSize: '14px',
                  padding: '6px 8px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  letterSpacing: '1px',
                }}
                required
                disabled={isLoading}
                autoComplete="username"
              />
            </div>

            <div style={{ marginBottom: '6px' }}>
              <div style={{
                color: '#555555',
                fontSize: '9px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                marginBottom: '1px',
              }}>
                ACCESS CODE
              </div>
              <input
                type="password"
                value={password}
                onChange={function(e) { setPassword(e.target.value); }}
                style={{
                  width: '100%',
                  backgroundColor: '#f5f5f5',
                  border: '2px solid #cccccc',
                  color: '#111111',
                  fontFamily: "'Courier New', Courier, monospace",
                  fontSize: '14px',
                  padding: '6px 8px',
                  outline: 'none',
                  boxSizing: 'border-box',
                  letterSpacing: '1px',
                }}
                required
                disabled={isLoading}
                autoComplete="current-password"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: '100%',
                backgroundColor: accent,
                color: '#ffffff',
                fontFamily: "'Courier New', Courier, monospace",
                fontSize: '13px',
                fontWeight: 'bold',
                letterSpacing: '2px',
                padding: '8px',
                border: 'none',
                cursor: 'pointer',
                opacity: isLoading ? 0.5 : 1,
              }}
            >
              {isLoading ? 'CONNECTING...' : 'LOGIN'}
            </button>
          </form>

          <div style={{
            textAlign: 'center',
            color: '#999999',
            fontSize: '8px',
            letterSpacing: '1px',
            marginTop: '8px',
          }}>
            V2.4.1 // AES-256
          </div>
        </div>
      </div>
    );
  }

  return (
    <MobileFrame hideNav connectionStatus="connected">
      <div className="h-full flex flex-col p-6 items-center justify-center relative">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
        
        <div className="w-full max-w-sm flex flex-col items-center gap-8 z-10">
          <div className="flex flex-col items-center gap-4">
            <div className="h-24 w-24 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center shadow-2xl relative overflow-hidden group">
              <div className="absolute inset-0 bg-gradient-to-tr from-primary/20 to-transparent" />
              <Shield className="h-12 w-12 text-primary relative z-10" />
              <Radio className="h-12 w-12 text-primary/20 absolute z-0 scale-150" />
            </div>
            
            <div className="text-center">
              <h1 className="text-2xl font-display font-bold tracking-wider text-white">
                COMMAND
                <span className="block text-primary">COMMUNICATIONS</span>
              </h1>
              <p className="text-xs text-zinc-500 mt-2 font-mono tracking-widest uppercase">
                Reeder Systems // Secure Link
              </p>
            </div>
          </div>

          <form onSubmit={handleLogin} className="w-full space-y-4">
            {sessionConflict && (
              <div className="flex items-center gap-2 p-3 bg-amber-950/50 border border-amber-900/50 rounded-lg text-amber-400 text-sm">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>Your session was used by another account. Please sign in again.</span>
              </div>
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-950/50 border border-red-900/50 rounded-lg text-red-400 text-sm">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            
            <div className="space-y-2">
              <div className="relative group">
                <input
                  type="text"
                  placeholder="UNIT ID"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full bg-zinc-900/50 border border-zinc-800 text-white placeholder:text-zinc-600 h-12 font-mono tracking-wider focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all pl-10 pr-4 rounded-md outline-none"
                  required
                  disabled={isLoading}
                />
                <Shield className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600 group-focus-within:text-primary transition-colors" />
              </div>
              
              <div className="relative group">
                <input
                  type="password"
                  placeholder="ACCESS CODE"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-zinc-900/50 border border-zinc-800 text-white placeholder:text-zinc-600 h-12 font-mono tracking-wider focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all pl-10 pr-4 rounded-md outline-none"
                  required
                  disabled={isLoading}
                />
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600 group-focus-within:text-primary transition-colors" />
              </div>
            </div>

            <button 
              type="submit" 
              className="w-full h-14 bg-primary hover:bg-primary/90 text-background font-bold tracking-widest text-lg uppercase shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed rounded-md flex items-center justify-center gap-2"
              disabled={isLoading}
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  CONNECTING <span className="animate-pulse">...</span>
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  AUTHENTICATE <ArrowRight className="h-5 w-5" />
                </span>
              )}
            </button>
          </form>

          <div className="mt-8 pt-8 border-t border-white/5 w-full flex justify-between text-[10px] text-zinc-600 font-mono uppercase">
            <span>Ver: 2.4.1-RC</span>
            <span>SECURE: AES-256</span>
          </div>
        </div>
      </div>
    </MobileFrame>
  );
}
