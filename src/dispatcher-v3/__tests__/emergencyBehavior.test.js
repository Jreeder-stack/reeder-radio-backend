import { describe, expect, it } from 'vitest';
import { buildMdcTonePcm, classifyOfficerEmergency } from '../liveRuntime.js';

describe('Dispatcher V3 officer emergency recognition', () => {
  it.each([
    ['shots fired', 'SHOTS FIRED'],
    ['I have one at gun point', 'AT GUNPOINT'],
    ['I have him at taser point', 'AT TASER POINT'],
    ["I'm fighting with him", 'OFFICER FIGHTING'],
    ["I've been shot", 'OFFICER INJURED'],
    ['I need help', 'OFFICER NEEDS ASSISTANCE'],
    ['send me another unit', 'OFFICER NEEDS ASSISTANCE'],
  ])('recognizes unit-involved emergency language: %s', (transcript, reason) => {
    expect(classifyOfficerEmergency(transcript)).toMatchObject({ reason });
  });

  it.each([
    'caller reports shots fired',
    'report of shots fired at 123 Main',
    'responding to a shots fired call',
    'complainant says there is a fight',
    'victim reports a man has a gun',
  ])('does not mistake reported incidents for an officer emergency: %s', (transcript) => {
    expect(classifyOfficerEmergency(transcript)).toBeNull();
  });
});

describe('Dispatcher V3 MDC alert tone', () => {
  it('builds two seconds of 16 kHz signed PCM matching the existing Tone B duration', () => {
    const pcm = buildMdcTonePcm(2000);
    expect(Buffer.isBuffer(pcm)).toBe(true);
    expect(pcm.length).toBe(16000 * 2 * 2);

    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
    expect(samples.length).toBe(32000);
    expect(new Set(Array.from(samples.slice(0, 1000)))).toEqual(new Set([12000, -12000]));
  });
});
