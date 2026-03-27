export const PCM_SPEC = {
  type: 'audio',
  codec: 'pcm',
  sampleRate: 48000,
  channels: 1,
  frameSamples: 960,
};

export function buildPcmPacket(sequence, channelId, int16Frame) {
  return {
    type: PCM_SPEC.type,
    codec: PCM_SPEC.codec,
    sampleRate: PCM_SPEC.sampleRate,
    channels: PCM_SPEC.channels,
    frameSamples: PCM_SPEC.frameSamples,
    sequence,
    channelId,
    payload: Array.from(int16Frame),
  };
}

export function validatePcmPacket(packet) {
  if (!packet || typeof packet !== 'object') return false;
  if (packet.type !== PCM_SPEC.type) return false;
  if (packet.codec !== PCM_SPEC.codec) return false;
  if (packet.sampleRate !== PCM_SPEC.sampleRate) return false;
  if (packet.channels !== PCM_SPEC.channels) return false;
  if (packet.frameSamples !== PCM_SPEC.frameSamples) return false;
  if (!Number.isInteger(packet.sequence)) return false;
  if (!Array.isArray(packet.payload)) return false;
  if (packet.payload.length !== PCM_SPEC.frameSamples) return false;
  return true;
}
