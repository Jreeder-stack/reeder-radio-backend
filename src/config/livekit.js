import { AccessToken } from 'livekit-server-sdk';
import { config } from './env.js';

export function createLiveKitToken(identity, roomName, options = {}) {
  if (!config.livekit.apiKey || !config.livekit.apiSecret) {
    throw new Error('LiveKit credentials not configured');
  }

  const token = new AccessToken(
    config.livekit.apiKey,
    config.livekit.apiSecret,
    {
      identity,
      ttl: options.ttl || '24h',
    }
  );

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: options.canPublish !== false,
    canSubscribe: options.canSubscribe !== false,
    canPublishData: options.canPublishData !== false,
  });

  return token.toJwt();
}

export function getLiveKitUrl() {
  return config.livekit.url;
}
