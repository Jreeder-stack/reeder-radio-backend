export const PCM_SPEC = {
  type: 'audio',
  codec: 'pcm',
  sampleRate: 48000,
  channels: 1,
  frameSamples: 960,
};

export const WS_BINARY_MARKER = 0x01;
export const WS_BINARY_MARKER_OPUS = 0x02;

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
    if (marker !== WS_BINARY_MARKER && marker !== WS_BINARY_MARKER_OPUS) return null;
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

    if (marker === WS_BINARY_MARKER_OPUS) {
      const opusData = new Uint8Array(arrayBuffer.slice(offset));
      if (opusData.length === 0) return null;
      return { sequence, channelId, senderUnitId, codec: 'opus', opusData, samples: null };
    }

    const pcmByteLength = arrayBuffer.byteLength - offset;
    if (pcmByteLength < 2 || pcmByteLength % 2 !== 0) return null;
    const samples = new Int16Array(arrayBuffer.slice(offset, offset + pcmByteLength));
    return { sequence, channelId, senderUnitId, codec: 'pcm', opusData: null, samples };
  } catch (e) {
    console.warn('AUDIO_BINARY_PARSE_ERROR', e.message);
    return null;
  }
}

function truncateUtf8(encoder, str, maxBytes) {
  let encoded = encoder.encode(str || '');
  if (encoded.length > maxBytes) encoded = encoded.slice(0, maxBytes);
  return encoded;
}

export function buildBinaryFrame(sequence, channelId, unitId, int16Frame) {
  const encoder = new TextEncoder();
  const channelBytes = truncateUtf8(encoder, channelId, 255);
  const senderBytes = truncateUtf8(encoder, unitId, 255);
  const headerLen = 1 + 4 + 1 + channelBytes.length + 1 + senderBytes.length;
  const pcmBytes = int16Frame.length * 2;
  const buf = new ArrayBuffer(headerLen + pcmBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let offset = 0;
  view.setUint8(offset, WS_BINARY_MARKER); offset += 1;
  view.setUint32(offset, sequence, true); offset += 4;
  view.setUint8(offset, channelBytes.length); offset += 1;
  u8.set(channelBytes, offset); offset += channelBytes.length;
  view.setUint8(offset, senderBytes.length); offset += 1;
  u8.set(senderBytes, offset); offset += senderBytes.length;
  const pcmU8 = new Uint8Array(int16Frame.buffer, int16Frame.byteOffset, int16Frame.byteLength);
  u8.set(pcmU8, offset);
  return buf;
}

export function buildBinaryFrameOpus(sequence, channelId, unitId, opusPayload) {
  const encoder = new TextEncoder();
  const channelBytes = truncateUtf8(encoder, channelId, 255);
  const senderBytes = truncateUtf8(encoder, unitId, 255);
  const headerLen = 1 + 4 + 1 + channelBytes.length + 1 + senderBytes.length;
  const buf = new ArrayBuffer(headerLen + opusPayload.length);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let offset = 0;
  view.setUint8(offset, WS_BINARY_MARKER_OPUS); offset += 1;
  view.setUint32(offset, sequence, true); offset += 4;
  view.setUint8(offset, channelBytes.length); offset += 1;
  u8.set(channelBytes, offset); offset += channelBytes.length;
  view.setUint8(offset, senderBytes.length); offset += 1;
  u8.set(senderBytes, offset); offset += senderBytes.length;
  u8.set(opusPayload, offset);
  return buf;
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
