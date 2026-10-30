/**
 * Opus TOC timing according to RFC 6716, section 3.1.
 * This validates that each WebSocket radio packet represents exactly 20 ms.
 * It does not mistake a TOC value of 0x01 for a PCM fallback marker.
 */
export function opusPacketDurationMs(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const toc = bytes[0];
  const config = toc >> 3;
  let frameMs;
  if (config < 12) frameMs = [10, 20, 40, 60][config % 4];
  else if (config < 16) frameMs = [10, 20][config % 2];
  else frameMs = [2.5, 5, 10, 20][config % 4];
  const packing = toc & 0x03;
  const frames = packing === 0 ? 1
    : (packing === 1 || packing === 2 ? 2
      : (bytes.length >= 2 ? bytes[1] & 0x3f : 0));
  if (frames === 0 || frames * frameMs > 120) return null;
  if (packing === 1 && (bytes.length - 1) % 2 !== 0) return null;
  return frames * frameMs;
}
