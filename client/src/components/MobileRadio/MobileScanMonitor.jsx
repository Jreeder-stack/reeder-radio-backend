import { useEffect, useState } from "react";
import { MobileFrame } from "./MobileFrame";
import { Switch } from "../ui/Switch";
import { Radio, Zap, Pause, Play, Loader2 } from "lucide-react";
import { cn } from "../../lib/utils";
import { useMobileRadioContext } from "../../context/MobileRadioContext";

export function MobileScanMonitor() {
  const { isScanning, toggleScanning, scanChannels, setScanChannels, toggleScanChannel } = useMobileRadioContext();
  const [channels, setChannels] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch('/api/channels', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setChannels(data);
        }
        setIsLoading(false);
      })
      .catch(err => {
        console.error('Failed to load channels:', err);
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    if (channels.length > 0) {
      setScanChannels(prev => {
        const existingIds = new Set(prev.map(c => c.id));
        const newChannelIds = new Set(channels.map(c => c.id));
        
        if (prev.length === 0) {
          return channels.map(ch => ({
            id: ch.id,
            name: ch.name,
            enabled: true,
          }));
        }
        
        const updated = prev.filter(c => newChannelIds.has(c.id));
        const newChannels = channels
          .filter(ch => !existingIds.has(ch.id))
          .map(ch => ({ id: ch.id, name: ch.name, enabled: true }));
        
        return [...updated, ...newChannels];
      });
    }
  }, [channels, setScanChannels]);

  return (
    <MobileFrame title="SCANNER CONFIG">
      <div className="flex flex-col h-full">
        
        <div className="p-6 bg-zinc-900/50 border-b border-white/5 flex flex-col items-center gap-4">
          <div className="relative">
            <div className={cn(
              "w-32 h-32 rounded-full flex items-center justify-center border-4 transition-all duration-500",
              isScanning 
                ? "border-emerald-500/50 bg-emerald-500/10 shadow-[0_0_30px_rgba(16,185,129,0.2)]" 
                : "border-zinc-700 bg-zinc-800"
            )}>
              <Zap className={cn(
                "w-12 h-12 transition-colors",
                isScanning ? "text-emerald-500 fill-emerald-500/50" : "text-zinc-500"
              )} />
            </div>
            {isScanning && (
              <div className="absolute inset-0 w-full h-full border-t-2 border-emerald-400 rounded-full animate-spin" style={{ animationDuration: '2s' }} />
            )}
          </div>

          <div className="text-center">
            <h2 className="text-xl font-display font-bold text-white tracking-widest">
              {isScanning ? "SCANNING ACTIVE" : "SCANNER PAUSED"}
            </h2>
            <p className="text-xs text-zinc-500 mt-1 font-mono">
              {isScanning 
                ? `Monitoring ${scanChannels.filter(c => c.enabled).length} channels...` 
                : "Press start to begin monitoring"}
            </p>
          </div>

          <button
            onClick={toggleScanning}
            disabled={scanChannels.length === 0}
            className={cn(
              "flex items-center gap-2 px-8 py-3 rounded-full font-bold tracking-widest transition-all active:scale-95 shadow-lg disabled:opacity-50 disabled:cursor-not-allowed",
              isScanning 
                ? "bg-red-500/10 text-red-500 border border-red-500/50 hover:bg-red-500/20" 
                : "bg-emerald-500 text-black hover:bg-emerald-400"
            )}
          >
            {isScanning ? <><Pause size={18} /> STOP SCAN</> : <><Play size={18} /> START SCAN</>}
          </button>
        </div>

        <div className="flex-1 p-4 space-y-6 overflow-y-auto">
          
          <div className="space-y-2">
            <div className="flex items-center justify-between px-2 mb-2">
              <label className="text-xs font-bold text-zinc-500 uppercase">Scan Bank</label>
              {isLoading ? (
                <Loader2 className="h-4 w-4 text-zinc-500 animate-spin" />
              ) : (
                <span className="text-[10px] border border-zinc-700 text-zinc-400 px-2 py-0.5 rounded">
                  {scanChannels.length} CHANNELS
                </span>
              )}
            </div>
            
            {isLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-8 w-8 text-zinc-500 animate-spin" />
              </div>
            ) : scanChannels.length === 0 ? (
              <div className="text-center py-8 text-zinc-500 text-sm">
                No channels available
              </div>
            ) : (
              scanChannels.map((ch) => (
                <div 
                  key={ch.id}
                  className={cn(
                    "flex items-center justify-between p-4 border rounded-lg transition-colors",
                    ch.enabled 
                      ? "bg-zinc-900/40 border-white/5" 
                      : "bg-zinc-950/50 border-zinc-900 opacity-60"
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className="p-2 rounded bg-zinc-950 border border-zinc-800 text-zinc-600">
                      <Radio size={16} />
                    </div>
                    <div>
                      <p className={cn(
                        "font-bold text-sm transition-colors",
                        ch.enabled ? "text-zinc-200" : "text-zinc-500"
                      )}>{ch.name}</p>
                      <p className="text-[10px] text-zinc-600 font-mono">CH ID: {String(ch.id)}</p>
                    </div>
                  </div>
                  
                  <Switch 
                    checked={ch.enabled}
                    onCheckedChange={() => toggleScanChannel(ch.id)}
                  />
                </div>
              ))
            )}
          </div>

        </div>

      </div>
    </MobileFrame>
  );
}
