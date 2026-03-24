import { useState, useCallback } from "react";

interface UseLiveKitOptions {
  channelName: string | null;
  identity: string | null;
  enabled?: boolean;
}

export function useLiveKit({ channelName, identity, enabled = true }: UseLiveKitOptions) {
  const [isConnected] = useState(false);
  const [isConnecting] = useState(false);
  const [isReceiving] = useState(false);
  const [activeSpeaker] = useState<string | null>(null);

  const startTransmitting = useCallback(async () => {
    console.warn('[useLiveKit] LiveKit removed - use native audio transport');
  }, []);

  const stopTransmitting = useCallback(async () => {
    console.warn('[useLiveKit] LiveKit removed - use native audio transport');
  }, []);

  return {
    isConnected,
    isConnecting,
    isReceiving,
    activeSpeaker,
    startTransmitting,
    stopTransmitting,
  };
}
