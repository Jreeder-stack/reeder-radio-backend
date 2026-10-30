import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { StreamingPcmFrameResampler } from '../StreamingPcmFrameResampler.js';

function inputSignal(rate, length = rate) {
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.35 * Math.sin(2 * Math.PI * 440 * i / rate);
  }
  return samples;
}

function runResampler(rate) {
  const input = inputSignal(rate);
  const converter = new StreamingPcmFrameResampler(rate);
  const frames = [];
  for (let i = 0; i < input.length; i += 1024) {
    converter.push(input.subarray(i, i + 1024), (frame) => frames.push(frame));
  }
  return frames;
}

function runWorklet(rate) {
  const messages = [];
  let Processor;
  const source = readFileSync(new URL('../../../public/pcm-capture-worklet.js', import.meta.url), 'utf8');
  class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage(msg) { messages.push(msg); } };
    }
  }
  runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor(_name, ctor) { Processor = ctor; },
    sampleRate: rate,
    Float32Array, Int16Array, Math, Number,
  });
  const processor = new Processor();
  const input = inputSignal(rate);
  for (let i = 0; i < input.length; i += 128) {
    const out = new Float32Array(128).fill(0.5);
    processor.process([[input.subarray(i, i + 128)]], [[out]]);
    expect(out.every((sample) => sample === 0)).toBe(true);
  }
  return messages;
}

describe('desktop capture contract: one 320-sample 16 kHz frame per 20 ms', () => {
  for (const rate of [16000, 44100, 48000]) {
    it('ScriptProcessor fallback resamples a full second at ' + rate + ' Hz without drift', () => {
      const frames = runResampler(rate);
      expect(frames).toHaveLength(50);
      expect(frames.every((frame) => frame instanceof Int16Array && frame.length === 320)).toBe(true);
      const peak = Math.max(...frames[20]);
      expect(peak).toBeGreaterThan(1000);
      expect(peak).toBeLessThan(32767);
    });

    it('AudioWorklet delivers the same 50 radio frames at ' + rate + ' Hz', () => {
      const events = runWorklet(rate);
      const config = events.find((event) => event.type === 'captureConfig');
      expect(config.sourceSampleRate).toBe(rate);
      expect(config.targetSampleRate).toBe(16000);
      const frames = events.filter((event) => event.type === 'pcmFrame').map((event) => event.samples);
      expect(frames).toHaveLength(50);
      expect(frames.every((frame) => frame.length === 320)).toBe(true);
      expect(frames[20][30]).not.toBe(0);
    });
  }

  it('maintains frame timing when capture callbacks split the stream at irregular boundaries', () => {
    const input = inputSignal(48000, 48000 * 3);
    const converter = new StreamingPcmFrameResampler(48000);
    const frames = [];
    let offset = 0;
    while (offset < input.length) {
      const size = 137 + offset % 293;
      converter.push(input.subarray(offset, offset + size), (frame) => frames.push(frame));
      offset += size;
    }
    expect(frames).toHaveLength(150);
  });
});
