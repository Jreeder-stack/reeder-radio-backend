import { describe, expect, it } from 'vitest';
import OpusScript from 'opusscript';
import {
  RADIO_FLAG_CODEC_PCM,
  PCM_FALLBACK_PREFIX,
  PCM_FALLBACK_FRAME_BYTES,
  isRadioPcmFallback,
  isValidRadioAudioPayload,
  resolveRadioAudioCodec,
} from '../radioAudioCodecFlags.js';
import { audioRelayService } from '../audioRelayService.js';

describe('radio audio framing and codec isolation', () => {
  it('never interprets an Opus TOC byte of 0x01 as raw PCM', () => {
    const opusWithOverlappingToc = Buffer.from([0x01, 0x38, 0x65, 0x17]);
    expect(isRadioPcmFallback(0x01)).toBe(false);
    expect(isValidRadioAudioPayload(0x01, opusWithOverlappingToc)).toBe(true);
    expect(resolveRadioAudioCodec(0x01)).toBe('opus');

    const captured = [];
    const previousTap = audioRelayService._recordingTap;
    try {
      audioRelayService.onRecordingTap((event) => captured.push(event));
      const channelKey = 'TEST__CODEC';
      const packet = audioRelayService._buildRelayPacket({
        channelKey, channelIdNumeric: 31, senderUnitId: 'TEST-1',
        sequence: 100, opusPayload: opusWithOverlappingToc, flags: 0x01,
      });
      const parsed = audioRelayService._parsePacket(packet);
      expect(parsed.flags).toBe(0x01);
      audioRelayService._broadcastToAll(channelKey, 'TEST-1', packet, 100, parsed.opusPayload, 31);
      expect(captured).toHaveLength(1);
      expect(captured[0].codec).toBe('opus');
      expect(Buffer.from(captured[0].opusPayload)).toEqual(opusWithOverlappingToc);
    } finally {
      audioRelayService.onRecordingTap(previousTap);
    }
  });

  it('accepts PCM only with explicit header flag and 320 s16le samples', () => {
    const pcm = Buffer.alloc(PCM_FALLBACK_FRAME_BYTES);
    pcm[0] = PCM_FALLBACK_PREFIX;
    pcm.writeInt16LE(1200, 1);
    const flags = 0x01 | RADIO_FLAG_CODEC_PCM;
    expect(isRadioPcmFallback(flags)).toBe(true);
    expect(isValidRadioAudioPayload(flags, pcm)).toBe(true);
    expect(resolveRadioAudioCodec(flags)).toBe('pcm');
    expect(isValidRadioAudioPayload(flags, Buffer.from([0x01]))).toBe(false);
    expect(isValidRadioAudioPayload(flags, Buffer.alloc(PCM_FALLBACK_FRAME_BYTES))).toBe(false);
    expect(isValidRadioAudioPayload(flags, Buffer.alloc(PCM_FALLBACK_FRAME_BYTES + 2))).toBe(false);

    const captured = [];
    const previousTap = audioRelayService._recordingTap;
    try {
      audioRelayService.onRecordingTap((event) => captured.push(event));
      const packet = audioRelayService._buildRelayPacket({
        channelKey: 'TEST__CODEC', channelIdNumeric: 31, senderUnitId: 'TEST-1',
        sequence: 101, opusPayload: pcm, flags,
      });
      audioRelayService._broadcastToAll('TEST__CODEC', 'TEST-1', packet, 101, pcm, 31);
      expect(captured).toHaveLength(1);
      expect(captured[0].codec).toBe('pcm');
      expect(Buffer.from(captured[0].opusPayload)).toEqual(pcm.subarray(1));
    } finally {
      audioRelayService.onRecordingTap(previousTap);
    }
  });

  it('encodes and decodes real synthetic 20 ms 16 kHz Opus speech frames', () => {
    const encoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
    const decoder = new OpusScript(16000, 1, OpusScript.Application.VOIP);
    let nonZeroDecoded = 0;
    try {
      encoder.encoderCTL(4002, 32000);
      for (let frameNumber = 0; frameNumber < 8; frameNumber++) {
        const samples = new Int16Array(320);
        for (let i = 0; i < samples.length; i++) {
          samples[i] = Math.round(10000 * Math.sin(2 * Math.PI * 440 * (frameNumber * 320 + i) / 16000));
        }
        const encoded = Buffer.from(encoder.encode(Buffer.from(samples.buffer), 320));
        const packet = audioRelayService._buildRelayPacket({
          channelKey: 'TEST__VOICE', channelIdNumeric: 31, senderUnitId: 'TEST-2',
          sequence: frameNumber, opusPayload: encoded, flags: 0x01,
        });
        const parsed = audioRelayService._parsePacket(packet);
        expect(resolveRadioAudioCodec(parsed.flags)).toBe('opus');
        const decoded = Buffer.from(decoder.decode(parsed.opusPayload, 5760));
        expect(decoded.length).toBe(640);
        if (decoded.some((byte) => byte !== 0)) nonZeroDecoded++;
      }
      expect(nonZeroDecoded).toBeGreaterThan(1);
    } finally {
      encoder.delete();
      decoder.delete();
    }
  });
});
