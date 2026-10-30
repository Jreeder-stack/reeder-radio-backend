/**
 * Codec bit in radio packet header flags (wire versions 1 and 2).
 * The payload's first byte must NEVER be used as a codec discriminator:
 * 0x01 is both the legacy PCM fallback prefix and a legal Opus TOC byte.
 */
export const RADIO_FLAG_CODEC_PCM = 0x04;
export const PCM_FALLBACK_PREFIX = 0x01;
export const PCM_FALLBACK_FRAME_BYTES = 1 + 320 * 2; // prefix + 20 ms, 16 kHz, mono s16le

export function isRadioPcmFallback(flags) {
  return (flags & RADIO_FLAG_CODEC_PCM) !== 0;
}

export function isValidRadioAudioPayload(flags, payload) {
  if (!payload || typeof payload.length !== 'number') return false;
  if (!isRadioPcmFallback(flags)) return true; // includes zero-byte keepalives
  return payload.length === PCM_FALLBACK_FRAME_BYTES && payload[0] === PCM_FALLBACK_PREFIX;
}

export function resolveRadioAudioCodec(flags) {
  return isRadioPcmFallback(flags) ? 'pcm' : 'opus';
}
