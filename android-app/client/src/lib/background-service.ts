import { Capacitor, registerPlugin } from '@capacitor/core';

export interface BackgroundServicePlugin {
  startService(): Promise<{ success: boolean }>;
  isServiceRunning(): Promise<{ running: boolean }>;
  updateConnectionInfo(options: {
    serverBaseUrl?: string;
    unitId?: string;
    channelId?: string;
    livekitUrl?: string;
    channelName?: string;
  }): Promise<{ success: boolean }>;
  clearConnectionInfo(): Promise<{ success: boolean }>;
}

const BackgroundService = registerPlugin<BackgroundServicePlugin>('BackgroundService');

export { BackgroundService };

export async function syncBackgroundConnectionInfo(options: {
  serverBaseUrl?: string | null;
  unitId?: string | null;
  channelId?: string | null;
  livekitUrl?: string | null;
  channelName?: string | null;
}): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') {
    return;
  }

  const shouldClear = Object.values(options).every((value) => value == null);

  try {
    if (shouldClear) {
      await BackgroundService.clearConnectionInfo();
      console.log('[BackgroundService] Connection info cleared');
      return;
    }

    try {
      await BackgroundService.startService();
    } catch (error) {
      console.warn('[BackgroundService] startService failed before sync:', error);
    }

    const payload = {
      serverBaseUrl: options.serverBaseUrl ?? undefined,
      unitId: options.unitId ?? undefined,
      channelId: options.channelId ?? undefined,
      livekitUrl: options.livekitUrl ?? undefined,
      channelName: options.channelName ?? undefined,
    };

    await BackgroundService.updateConnectionInfo(payload);
    console.log('[BackgroundService] Connection info synced:', payload);
  } catch (error) {
    console.warn('[BackgroundService] connection info sync failed:', error, options);
  }
}
