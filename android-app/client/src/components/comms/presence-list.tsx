import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { Mic, Loader2, WifiOff } from "lucide-react";
import { usePresence } from "@/hooks/use-presence";

export function PresenceList() {
  const { data: units = [], isLoading, error } = usePresence();
  const onlineCount = units.filter(u => u.status === 'online' || u.status === 'busy' || u.status === 'idle').length;
  
  return (
    <div className="flex flex-col h-full bg-zinc-900/50 rounded-xl border border-white/5 overflow-hidden">
      <div className="p-3 bg-zinc-900 border-b border-white/5 flex justify-between items-center">
        <h3 className="text-xs font-bold text-zinc-400 uppercase tracking-widest">Active Units</h3>
        {isLoading ? (
          <Loader2 className="h-4 w-4 text-zinc-500 animate-spin" />
        ) : error ? (
          <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 text-[10px] font-bold border border-amber-500/20 flex items-center gap-1">
            <WifiOff className="h-3 w-3" /> OFFLINE
          </span>
        ) : (
          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-500 text-[10px] font-bold border border-emerald-500/20">
            {onlineCount} ONLINE
          </span>
        )}
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {units.map((unit) => (
            <div 
              key={unit.id}
              data-testid={`unit-presence-${unit.id}`}
              className={cn(
                "flex items-center gap-3 p-2 rounded-lg transition-colors border border-transparent",
                unit.isTalking 
                  ? "bg-primary/10 border-primary/30" 
                  : "hover:bg-white/5"
              )}
            >
              <div className="relative">
                <Avatar className="h-8 w-8 rounded-md bg-zinc-800 border border-white/10">
                  <AvatarFallback className="bg-zinc-800 text-zinc-400 text-xs font-bold">
                    {unit.unit_identity?.substring(0, 2) || '??'}
                  </AvatarFallback>
                </Avatar>
                <div className={cn(
                  "absolute -bottom-1 -right-1 h-3 w-3 rounded-full border-2 border-zinc-950",
                  unit.status === 'online' || unit.status === 'idle' ? "bg-emerald-500" :
                  unit.status === 'busy' ? "bg-amber-500" : "bg-zinc-600"
                )} />
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center">
                  <span className={cn(
                    "text-sm font-bold truncate",
                    unit.isTalking ? "text-primary" : "text-zinc-300"
                  )}>
                    {unit.unit_identity}
                  </span>
                  {unit.isTalking && (
                    <Mic className="h-3 w-3 text-primary animate-pulse" />
                  )}
                </div>
                <div className="flex justify-between items-center mt-0.5">
                  <span className="text-[10px] text-zinc-500 font-mono">CH: {unit.channel || 'N/A'}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
