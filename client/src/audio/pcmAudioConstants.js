export const PCM_AUDIO = {
  SAMPLE_RATE: 48000,
  CHANNELS: 1,
  BIT_DEPTH: 16,
  FRAME_SAMPLES: 960,
  FRAME_DURATION_MS: 20,
  FRAME_BYTES: 1920,
  CODEC: 'pcm',
  CODEC_ID: 0x01,
  FRAME_TYPE: 0x10,
};

export function buildPcmPacket(sequence, senderUnitId, channelId, pcmPayload) {
  const senderBytes = new TextEncoder().encode(senderUnitId);
  const channelBytes = new TextEncoder().encode(channelId);

  const headerSize = 1 + 1 + 2 + 1 + 2 + 2 + 1 + senderBytes.length + 1 + channelBytes.length + 2;
  const totalSize = headerSize + pcmPayload.byteLength;
  const buf = new ArrayBuffer(totalSize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  let offset = 0;
  view.setUint8(offset, PCM_AUDIO.FRAME_TYPE); offset += 1;
  view.setUint8(offset, PCM_AUDIO.CODEC_ID); offset += 1;
  view.setUint16(offset, PCM_AUDIO.SAMPLE_RATE, false); offset += 2;
  view.setUint8(offset, PCM_AUDIO.CHANNELS); offset += 1;
  view.setUint16(offset, PCM_AUDIO.FRAME_SAMPLES, false); offset += 2;
  view.setUint16(offset, sequence & 0xFFFF, false); offset += 2;
  view.setUint8(offset, senderBytes.length); offset += 1;
  bytes.set(senderBytes, offset); offset += senderBytes.length;
  view.setUint8(offset, channelBytes.length); offset += 1;
  bytes.set(channelBytes, offset); offset += channelBytes.length;
  view.setUint16(offset, pcmPayload.byteLength, false); offset += 2;
  bytes.set(new Uint8Array(pcmPayload.buffer || pcmPayload, pcmPayload.byteOffset || 0, pcmPayload.byteLength), offset);

  return buf;
}

export const PCM_HEADER_MIN_SIZE = 1 + 1 + 2 + 1 + 2 + 2 + 1 + 0 + 1 + 0 + 2;

export function parsePcmPacket(arrayBuffer) {
  const len = arrayBuffer.byteLength;
  if (len < PCM_HEADER_MIN_SIZE) return null;

  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  let offset = 0;
  const frameType = view.getUint8(offset); offset += 1;
  if (frameType !== PCM_AUDIO.FRAME_TYPE) return null;

  const codecId = view.getUint8(offset); offset += 1;
  const sampleRate = view.getUint16(offset, false); offset += 2;
  const channels = view.getUint8(offset); offset += 1;
  const frameSamples = view.getUint16(offset, false); offset += 2;
  const sequence = view.getUint16(offset, false); offset += 2;

  if (offset + 1 > len) return null;
  const senderIdLen = view.getUint8(offset); offset += 1;
  if (offset + senderIdLen > len) return null;
  const senderUnitId = new TextDecoder().decode(bytes.slice(offset, offset + senderIdLen)); offset += senderIdLen;

  if (offset + 1 > len) return null;
  const channelIdLen = view.getUint8(offset); offset += 1;
  if (offset + channelIdLen > len) return null;
  const channelId = new TextDecoder().decode(bytes.slice(offset, offset + channelIdLen)); offset += channelIdLen;

  if (offset + 2 > len) return null;
  const payloadBytes = view.getUint16(offset, false); offset += 2;
  if (offset + payloadBytes > len) return null;

  if (payloadBytes !== PCM_AUDIO.FRAME_BYTES || payloadBytes % 2 !== 0) return null;

  const payload = new Int16Array(arrayBuffer.slice(offset, offset + payloadBytes));

  const codec = codecId === PCM_AUDIO.CODEC_ID ? 'pcm' : `unknown(${codecId})`;

  return {
    type: frameType,
    codec,
    sampleRate,
    channels,
    frameSamples,
    sequence,
    senderUnitId,
    channelId,
    payloadBytes,
    payload,
  };
}

export function validatePcmPacketMeta(packet) {
  const errors = [];
  if (packet.codec !== 'pcm') errors.push(`codec=${packet.codec}`);
  if (packet.sampleRate !== PCM_AUDIO.SAMPLE_RATE) errors.push(`sampleRate=${packet.sampleRate}`);
  if (packet.channels !== PCM_AUDIO.CHANNELS) errors.push(`channels=${packet.channels}`);
  if (packet.frameSamples !== PCM_AUDIO.FRAME_SAMPLES) errors.push(`frameSamples=${packet.frameSamples}`);
  return { valid: errors.length === 0, errors };
}
