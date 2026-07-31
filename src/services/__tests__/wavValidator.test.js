import { describe, expect, it } from 'vitest';
import {
  createPcmWavBuffer,
  isValidWav,
  prepareWavForPlayback,
  repairLegacyRecordingTapWav,
} from '../wavValidator.js';

function makeLegacyRecordingTapWav(pcmData) {
  const sampleRate = 16000;
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const wav = createPcmWavBuffer(pcmData, sampleRate, channels, bitsPerSample);

  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 30);
  wav.writeUInt16LE(bitsPerSample, 32);
  wav.writeUInt16LE(0, 34);
  return wav;
}

describe('WAV validation and legacy RecordingTap repair', () => {
  it('creates a canonical playable PCM WAV header', () => {
    const pcm = Buffer.alloc(3200, 0x11);
    const wav = createPcmWavBuffer(pcm, 16000, 1, 16);

    expect(isValidWav(wav)).toBe(true);
    expect(wav.readUInt32LE(28)).toBe(32000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('repairs recordings created by the overlapping legacy header writes', () => {
    const pcm = Buffer.alloc(3200, 0x22);
    const legacy = makeLegacyRecordingTapWav(pcm);

    expect(legacy.readUInt32LE(28)).toBe(163072);
    expect(legacy.readUInt16LE(32)).toBe(16);
    expect(legacy.readUInt16LE(34)).toBe(0);
    expect(isValidWav(legacy)).toBe(false);

    const repaired = repairLegacyRecordingTapWav(legacy);
    expect(repaired).not.toBeNull();
    expect(isValidWav(repaired)).toBe(true);
    expect(repaired.readUInt32LE(28)).toBe(32000);
    expect(repaired.readUInt16LE(32)).toBe(2);
    expect(repaired.readUInt16LE(34)).toBe(16);
    expect(repaired.subarray(44)).toEqual(pcm);

    const prepared = prepareWavForPlayback(legacy);
    expect(prepared?.repairedLegacyHeader).toBe(true);
    expect(prepared?.buffer).toEqual(repaired);
  });

  it('does not disguise unrelated invalid bytes as a WAV', () => {
    const invalid = Buffer.alloc(100);
    invalid.write('RIFF', 0);
    invalid.write('WAVE', 8);

    expect(isValidWav(invalid)).toBe(false);
    expect(repairLegacyRecordingTapWav(invalid)).toBeNull();
    expect(prepareWavForPlayback(invalid)).toBeNull();
  });
});
