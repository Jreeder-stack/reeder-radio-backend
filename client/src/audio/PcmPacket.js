export const PCM_SPEC = {
  type: 'audio',
  codec: 'pcm',
  sampleRate: 48000,
  channels: 1,
  frameSamples: 960,
};

export const WS_BINARY_MARKER = 0x01;

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

export function parseBinaryAudioFrame(arrayBuffer) {
  try {
    if (arrayBuffer.byteLength < 7) return null;
    const view = new DataView(arrayBuffer);
    let offset = 0;
    const marker = view.getUint8(offset); offset += 1;
    if (marker !== WS_BINARY_MARKER) return null;
    const sequence = view.getUint32(offset, true); offset += 4;
    if (offset >= arrayBuffer.byteLength) return null;
    const channelIdLen = view.getUint8(offset); offset += 1;
    if (offset + channelIdLen >= arrayBuffer.byteLength) return null;
    const channelIdBytes = new Uint8Array(arrayBuffer, offset, channelIdLen);
    const channelId = new TextDecoder().decode(channelIdBytes); offset += channelIdLen;
    if (offset >= arrayBuffer.byteLength) return null;
    const senderIdLen = view.getUint8(offset); offset += 1;
    if (offset + senderIdLen > arrayBuffer.byteLength) return null;
    const senderIdBytes = new Uint8Array(arrayBuffer, offset, senderIdLen);
    const senderUnitId = new TextDecoder().decode(senderIdBytes); offset += senderIdLen;
    const pcmByteLength = arrayBuffer.byteLength - offset;
    if (pcmByteLength < 2 || pcmByteLength % 2 !== 0) return null;
    const samples = new Int16Array(arrayBuffer.slice(offset, offset + pcmByteLength));
    return { sequence, channelId, senderUnitId, samples };
  } catch (e) {
    console.warn('AUDIO_BINARY_PARSE_ERROR', e.message);
    return null;
  }
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
