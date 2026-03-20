import { useState, useEffect, useRef } from "react";
import { MobileFrame } from "@/components/layout/mobile-frame";
import { PTTButton } from "@/components/comms/ptt-button";
import { PresenceList } from "@/components/comms/presence-list";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Radio, Activity, Loader2, Wifi, WifiOff, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRadio } from "@/lib/radio-context";
import { useChannels } from "@/hooks/use-channels";
import { useLiveKitCombined } from "@/hooks/use-livekit-combined";
import { useLocation } from "@/hooks/use-location";
import { apiClient } from "@/lib/api-client";

export default function MainCommsPage() {
  const { isScanning, toggleScanning, isEmergency, triggerEmergency, cancelEmergency } = useRadio();
  const { data: channels = [], isLoading: channelsLoading, error: channelsError } = useChannels();
  const [currentChannel, setCurrentChannel] = useState("");
  const hasJoinedRef = useRef(false);
  
  // Convert channel ID to string for comparison (backend returns number, Select uses string)
  const currentChannelName = channels.find(ch => String(ch.id) === currentChannel)?.name || null;
  const unitId = apiClient.getUnitId();
  
  const { 
    latitude, 
    longitude, 
    isTracking: isLocationTracking,
    error: locationError 
  } = useLocation({ 
    autoStart: true 
  });
  
  const { 
    isConnected: liveKitConnected, 
    isConnecting: liveKitConnecting,
    error: liveKitError,
    isReceiving,
    activeSpeaker,
    startTransmitting,
    stopTransmitting,
    participants: liveKitParticipants,
    isNative: isNativeLiveKit
  } = useLiveKitCombined({ 
    channelId: currentChannel,
    channelName: currentChannelName,
    identity: unitId,
    enabled: !!currentChannel 
  });
  
  useEffect(() => {
    if (channels?.length && (!currentChannel || !channels.find(ch => String(ch.id) === currentChannel))) {
      setCurrentChannel(String(channels[0].id));
    }
  }, [channels, currentChannel]);

  // Notify backend when joining a channel
  useEffect(() => {
    if (currentChannel && !hasJoinedRef.current) {
      hasJoinedRef.current = true;
      const channel = channels.find(ch => String(ch.id) === currentChannel);
      if (channel) {
        apiClient.joinChannel(currentChannel, channel.name).catch(console.error);
      }
    }
  }, [currentChannel, channels]);

  const handleChannelChange = (channelId: string) => {
    setCurrentChannel(channelId);
    const channel = channels.find(ch => String(ch.id) === channelId);
    if (channel) {
      apiClient.joinChannel(channelId, channel.name).catch(console.error);
    }
  };

  const handleEmergencyToggle = async () => {
    const channel = currentChannelName || 'DISPATCH';
    
    if (isEmergency) {
      await cancelEmergency();
      // Notify AI dispatcher that emergency is cancelled
      try {
        await apiClient.notifyEmergency(channel, false);
        console.log('[Emergency] Cancelled and notified dispatcher');
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher of cancellation:', err);
      }
    } else {
      await triggerEmergency();
      // Notify AI dispatcher of emergency
      try {
        await apiClient.notifyEmergency(channel, true);
        console.log('[Emergency] Triggered and notified dispatcher');
      } catch (err) {
        console.error('[Emergency] Failed to notify dispatcher:', err);
      }
    }
  };

  return (
    <MobileFrame title="COMMUNICATIONS">
      <div className="h-full flex flex-col p-4 gap-4">
        
        {/* Top Controls: Channel + Scan */}
        <div className="flex gap-2">
            {/* Channel Selector */}
            <div className="flex-1 bg-zinc-900/50 p-4 rounded-xl border border-white/5 flex flex-col gap-2 relative overflow-hidden">
            <label className="text-xs font-bold text-zinc-500 uppercase tracking-widest">Active Channel</label>
            <Select value={currentChannel} onValueChange={handleChannelChange} disabled={channelsLoading}>
                <SelectTrigger className="h-12 bg-black/40 border-zinc-700 text-white font-mono font-bold text-lg tracking-wider focus:ring-primary/50 focus:border-primary/50">
                  {channelsLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading...
                    </span>
                  ) : (
                    <SelectValue placeholder="Select Channel" />
                  )}
                </SelectTrigger>
                <SelectContent className="bg-zinc-900 border-zinc-700 text-white font-mono">
                {channels.map((ch) => (
                    <SelectItem key={String(ch.id)} value={String(ch.id)} className="focus:bg-zinc-800 focus:text-primary">
                    {ch.name}
                    </SelectItem>
                ))}
                </SelectContent>
            </Select>
            </div>

            {/* Scan Toggle Button */}
            <button
                onClick={toggleScanning}
                className={cn(
                    "w-20 rounded-xl border flex flex-col items-center justify-center gap-2 transition-all active:scale-95 shadow-lg",
                    isScanning 
                    ? "bg-emerald-500/10 border-emerald-500/50 text-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]" 
                    : "bg-zinc-900/50 border-white/5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900"
                )}
            >
                {isScanning ? (
                    <>
                        <div className="relative">
                            <Activity className="w-8 h-8 animate-pulse" />
                            <div className="absolute inset-0 bg-emerald-500/20 blur-md rounded-full animate-pulse" />
                        </div>
                        <span className="text-[10px] font-bold tracking-wider">SCANNING</span>
                    </>
                ) : (
                    <>
                        <Activity className="w-8 h-8" />
                        <span className="text-[10px] font-bold tracking-wider">SCAN</span>
                    </>
                )}
            </button>
        </div>


        {/* Main PTT Area */}
        <div className="flex-1 flex flex-col items-center justify-center min-h-[250px] relative">
           {/* Emergency Button - Top Right of PTT Area */}
           <Button
            variant="destructive"
            size="sm"
            onClick={handleEmergencyToggle}
            className={cn(
              "absolute top-0 right-0 z-20 transition-all duration-300 font-bold tracking-widest",
              isEmergency ? "animate-pulse shadow-[0_0_20px_rgba(239,68,68,0.6)] bg-red-600 hover:bg-red-700" : "opacity-80 hover:opacity-100"
            )}
          >
            <AlertTriangle className="mr-2 h-4 w-4" />
            {isEmergency ? "EMERGENCY ACTIVE" : "EMERGENCY"}
          </Button>

          <PTTButton 
            channelStatus={liveKitConnected ? "clear" : liveKitConnecting ? "busy" : "error"}
            onTransmitStart={startTransmitting}
            onTransmitEnd={stopTransmitting}
            disabled={!liveKitConnected}
            isReceiving={isReceiving}
            activeSpeaker={activeSpeaker}
          />
          
          <div className="mt-8 text-center space-y-3">
             <div className="flex items-center justify-center gap-2">
               {liveKitConnecting ? (
                 <Loader2 className="w-4 h-4 text-yellow-500 animate-spin" />
               ) : liveKitConnected ? (
                 <Wifi className="w-4 h-4 text-emerald-500" />
               ) : (
                 <WifiOff className="w-4 h-4 text-red-500" />
               )}
               <p className={cn(
                   "text-xs font-mono uppercase tracking-widest transition-colors",
                   isEmergency ? "text-red-500 font-bold animate-pulse" : 
                   liveKitConnected ? "text-emerald-500" : 
                   liveKitConnecting ? "text-yellow-500" : "text-zinc-500"
               )}>
                 {isEmergency ? "EMERGENCY DECLARED" : 
                  liveKitConnected ? "CONNECTED" : 
                  liveKitConnecting ? "CONNECTING..." : 
                  liveKitError ? "CONNECTION ERROR" : "STANDING BY"}
               </p>
             </div>

             <p className="text-[10px] text-zinc-600">
               {liveKitConnected ? "Press and hold to transmit" : liveKitError || "Waiting for connection..."}
             </p>
             
             {liveKitParticipants.length > 0 && (
               <p className="text-[10px] text-cyan-500/70">
                 {liveKitParticipants.length} unit{liveKitParticipants.length !== 1 ? 's' : ''} on channel
               </p>
             )}
             
             <div className="flex items-center justify-center gap-1">
               <MapPin className={cn(
                 "w-3 h-3",
                 isLocationTracking && latitude ? "text-emerald-500" : 
                 locationError ? "text-red-500" : "text-zinc-600"
               )} />
               <p className="text-[10px] text-zinc-600">
                 {isLocationTracking && latitude ? "GPS Active" : 
                  locationError ? locationError : "GPS Initializing..."}
               </p>
             </div>
             
             {isNativeLiveKit && (
               <p className="text-[10px] text-cyan-600 font-mono">
                 [Native Audio SDK]
               </p>
             )}
          </div>
        </div>

        {/* Presence List (Bottom Sheet / Section) */}
        <div className="h-48 shrink-0">
          <PresenceList />
        </div>

      </div>
    </MobileFrame>
  );
}
