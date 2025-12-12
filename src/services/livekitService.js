import { createLiveKitToken, getLiveKitUrl } from '../config/livekit.js';

export async function generateToken(identity, roomName, options = {}) {
  const token = await createLiveKitToken(identity, roomName, options);
  return {
    token,
    url: getLiveKitUrl(),
    roomName,
    identity
  };
}

export async function generateDispatcherToken(identity, rooms) {
  const tokens = {};
  for (const roomName of rooms) {
    tokens[roomName] = await createLiveKitToken(identity, roomName, {
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });
  }
  return {
    tokens,
    url: getLiveKitUrl(),
    identity
  };
}
