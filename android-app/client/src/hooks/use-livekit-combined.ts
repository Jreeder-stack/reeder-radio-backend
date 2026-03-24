import { useState, useCallback } from "react";

interface UseLiveKitCombinedOptions {
  channelId?: string;
  channelName: string | null;
  identity: string | null;
  enabled?: boolean;
}

export function useLiveKitCombined({ channelId, channelName, identity, enabled = true }: UseLiveKitCombinedOptions) {
  const [isConnected] = useState(false);
  const [isConnecting] = useState(false);
  const [error] = useState<string | null>(null);
  const [isReceiving] = useState(false);
  const [activeSpeaker] = useState<string | null>(null);
  const [participants] = useState<any[]>([]);
  const [isNative] = useState(false);

  const startTransmitting = useCallback(async () => {
    console.warn('[useLiveKitCombined] LiveKit removed - use native audio transport');
  }, []);

  const stopTransmitting = useCallback(async () => {
    console.warn('[useLiveKitCombined] LiveKit removed - use native audio transport');
  }, []);

  return {
    isConnected,
    isConnecting,
    error,
    isReceiving,
    activeSpeaker,
    startTransmitting,
    stopTransmitting,
    participants,
    isNative,
  };
}
