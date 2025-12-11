export async function ensureRoomForChannel(channel) {
  console.log(`[LiveKit Stub] ensureRoomForChannel called for channel: ${channel?.name || channel}`);
  return {
    roomName: channel?.livekit_room_name || channel?.name || channel,
    created: false,
    stub: true
  };
}

export async function connectUnitToChannel(unitId, channelId) {
  console.log(`[LiveKit Stub] connectUnitToChannel called for unit: ${unitId}, channel: ${channelId}`);
  return {
    connected: false,
    unitId,
    channelId,
    stub: true
  };
}
