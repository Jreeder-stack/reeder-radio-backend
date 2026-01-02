import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { MobileFrame } from "@/components/layout/mobile-frame";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Shield, Lock, ArrowRight, Radio, AlertCircle } from "lucide-react";
import { apiClient } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type InterfaceMode = 'phone' | 'radio';

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interfaceMode, setInterfaceMode] = useState<InterfaceMode>('phone');
  const [, setLocation] = useLocation();

  useEffect(() => {
    const savedMode = localStorage.getItem('interface_mode') as InterfaceMode;
    if (savedMode === 'phone' || savedMode === 'radio') {
      setInterfaceMode(savedMode);
    }
  }, []);

  const handleInterfaceModeChange = (mode: InterfaceMode) => {
    setInterfaceMode(mode);
    localStorage.setItem('interface_mode', mode);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await apiClient.login({ username, password });
      
      if (response.success) {
        toast.success("Authentication successful");
        setLocation(interfaceMode === 'radio' ? "/comms-radio" : "/comms");
      } else {
        setError(response.error || "Login failed");
        toast.error(response.error || "Login failed");
      }
    } catch (err) {
      const errorMsg = "Network error - please try again";
      setError(errorMsg);
      toast.error(errorMsg);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <MobileFrame hideNav>
      <div className="h-full flex flex-col p-6 items-center justify-center relative">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/5 via-transparent to-transparent pointer-events-none" />
        
        <div className="w-full max-w-sm flex flex-col items-center gap-8 z-10">
          {/* Logo Section */}
          <div className="flex flex-col items-center gap-4 animate-in fade-in slide-in-from-bottom-4 duration-1000">
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

          {/* Form Section */}
          <form onSubmit={handleLogin} className="w-full space-y-4 animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-200">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-950/50 border border-red-900/50 rounded-lg text-red-400 text-sm animate-in fade-in slide-in-from-top-2">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
            
            <div className="space-y-2">
              <div className="relative group">
                <Input
                  type="text"
                  placeholder="UNIT ID"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="bg-zinc-900/50 border-zinc-800 text-white placeholder:text-zinc-600 h-12 font-mono tracking-wider focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all pl-10"
                  required
                  disabled={isLoading}
                />
                <Shield className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600 group-focus-within:text-primary transition-colors" />
              </div>
              
              <div className="relative group">
                <Input
                  type="password"
                  placeholder="ACCESS CODE"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="bg-zinc-900/50 border-zinc-800 text-white placeholder:text-zinc-600 h-12 font-mono tracking-wider focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all pl-10"
                  required
                  disabled={isLoading}
                />
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-600 group-focus-within:text-primary transition-colors" />
              </div>
            </div>

            <Button 
              type="submit" 
              className="w-full h-14 bg-primary hover:bg-primary/90 text-background font-bold tracking-widest text-lg uppercase shadow-[0_0_20px_rgba(6,182,212,0.3)] transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
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
            </Button>
          </form>

          {/* Interface Mode Toggle */}
          <div className="w-full mt-6 animate-in fade-in slide-in-from-bottom-12 duration-1000 delay-300">
            <label className="text-[10px] text-zinc-500 font-mono uppercase tracking-widest block text-center mb-3">
              Interface Style
            </label>
            <div className="flex rounded-lg border border-zinc-800 overflow-hidden">
              <button
                type="button"
                onClick={() => handleInterfaceModeChange('phone')}
                className={cn(
                  "flex-1 py-3 px-4 text-xs font-mono uppercase tracking-wider transition-all",
                  interfaceMode === 'phone' 
                    ? "bg-primary text-black font-bold" 
                    : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                )}
                data-testid="toggle-phone"
              >
                Phone
              </button>
              <button
                type="button"
                onClick={() => handleInterfaceModeChange('radio')}
                className={cn(
                  "flex-1 py-3 px-4 text-xs font-mono uppercase tracking-wider transition-all",
                  interfaceMode === 'radio' 
                    ? "bg-white text-black font-bold" 
                    : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                )}
                data-testid="toggle-radio"
              >
                Radio
              </button>
            </div>
          </div>

          <div className="mt-8 pt-8 border-t border-white/5 w-full flex justify-between text-[10px] text-zinc-600 font-mono uppercase">
            <span>Ver: 2.4.1-RC</span>
            <span>SECURE: AES-256</span>
          </div>
        </div>
      </div>
    </MobileFrame>
  );
}
