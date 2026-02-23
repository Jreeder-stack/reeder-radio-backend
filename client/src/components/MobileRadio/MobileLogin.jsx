import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { MobileFrame } from "./MobileFrame";
import { Shield, Lock, ArrowRight, Radio, AlertCircle } from "lucide-react";

export function MobileLogin({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const navigate = useNavigate();

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
