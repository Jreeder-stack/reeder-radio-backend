import { describe, expect, it } from 'vitest';
import OpusScript from 'opusscript';
import { opusPacketDurationMs } from '../OpusPacketDuration.js';

describe('20 ms radio Opus packet validation', () => {
  it('accepts the 0x01 Opus TOC as a 20 ms two-frame packet', () => {
    // RFC 6716: configuration 0 = 10 ms NB SILK, packing code 1 = two frames.
    expect(opusPacketDurationMs(new Uint8Array([0x01, 0x42, 0x65]))).toBe(20);
  });

  it('detects wrong duration and malformed frame-count headers', () => {
    expect(opusPacketDurationMs(new Uint8Array([0x08, 0x42]))).toBe(20);
    expect(opusPacketDurationMs(new Uint8Array([0xff, 0x02]))).toBe(40);
    expect(opusPacketDurationMs(new Uint8Array([0xff]))).toBeNull();
    expect(opusPacketDurationMs(new Uint8Array([]))).toBeNull();
    expect(opusPacketDurationMs(new Uint8Array([0x01, 0, 0, 0]))).toBeNull();
  });

  it('validates the duration of real Opus frames from a 16 kHz encoder', () => {
    const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
    try {
      for (let f = 0; f < 6; f++) {
        const pcm = new Int16Array(320);
        for (let i = 0; i < 320; i++) {
          pcm[i] = Math.round(4000 * Math.sin(2 * Math.PI * 250 * (f * 320 + i) / 16000));
        }
        const opus = encoder.encode(Buffer.from(pcm.buffer), 320);
        expect(opusPacketDurationMs(opus)).toBe(20);
      }
    } finally {
      encoder.delete();
    }
  });
});
