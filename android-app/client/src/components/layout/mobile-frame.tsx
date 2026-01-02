import { Link, useLocation } from "wouter";
import { Radio, Activity, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface MobileFrameProps {
  children: React.ReactNode;
  title?: string;
  hideNav?: boolean;
}

export function MobileFrame({ children, title, hideNav = false }: MobileFrameProps) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-black flex justify-center items-center p-0 md:p-8 font-body">
      {/* Phone Frame Mockup for Desktop */}
      <div className="w-full h-[100dvh] md:h-[850px] md:w-[412px] bg-background md:rounded-[2.5rem] md:border-[8px] md:border-zinc-900 overflow-hidden relative flex flex-col shadow-2xl">

        {/* App Header */}
        {!hideNav && (
          <div className="min-h-14 bg-zinc-900/90 backdrop-blur-md border-b border-white/5 flex items-center px-4 justify-between z-40 shrink-0 pt-[env(safe-area-inset-top,0px)]">
            <h1 className="text-lg font-display font-bold tracking-wider text-white uppercase truncate">
              {title || "COMMAND COMMS"}
            </h1>
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-[10px] text-emerald-500 font-bold tracking-wider">ONLINE</span>
            </div>
          </div>
        )}

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto relative bg-grid-pattern">
          {children}
        </div>

        {/* Bottom Navigation */}
        {!hideNav && (
          <nav className="min-h-16 bg-zinc-950 border-t border-white/10 flex items-center justify-around shrink-0 z-50 py-3 pb-[max(env(safe-area-inset-bottom,0px),12px)]">
            <NavItem 
              href="/comms" 
              icon={<Radio size={22} />} 
              label="RADIO" 
              active={location === "/comms"} 
            />
            <NavItem 
              href="/scan" 
              icon={<Activity size={22} />} 
              label="SCAN" 
              active={location === "/scan"} 
            />
            <NavItem 
              href="/settings" 
              icon={<Settings size={22} />} 
              label="SYSTEM" 
              active={location === "/settings"} 
            />
          </nav>
        )}
      </div>
    </div>
  );
}

function NavItem({ href, icon, label, active }: { href: string; icon: React.ReactNode; label: string; active: boolean }) {
  return (
    <Link href={href}>
      <div className={cn(
        "flex flex-col items-center justify-center w-20 h-full transition-colors active:scale-95 cursor-pointer",
        active ? "text-primary" : "text-zinc-500 hover:text-zinc-300"
      )}>
        <div className={cn("mb-1 transition-transform", active && "scale-110")}>
          {icon}
        </div>
        <span className="text-[10px] font-bold tracking-widest">{label}</span>
      </div>
    </Link>
  );
}
