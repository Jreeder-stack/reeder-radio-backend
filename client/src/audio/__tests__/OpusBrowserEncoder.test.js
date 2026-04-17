import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OpusBrowserEncoder } from '../OpusBrowserEncoder.js';

function makeMockAudioEncoderClass(stateOverride = 'configured') {
  const MockAudioEncoder = vi.fn(function () {
    this.state = stateOverride;
    this.configure = vi.fn();
    this.encode = vi.fn();
    this.flush = vi.fn().mockResolvedValue(undefined);
    this.close = vi.fn();
  });
  MockAudioEncoder.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
  return MockAudioEncoder;
}

describe('OpusBrowserEncoder', () => {
  let MockAudioEncoder;

  beforeEach(() => {
    MockAudioEncoder = makeMockAudioEncoderClass();
    vi.stubGlobal('AudioEncoder', MockAudioEncoder);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('isReady() returns false before init() is called', () => {
    const encoder = new OpusBrowserEncoder();
    expect(encoder.isReady()).toBe(false);
  });

  it('init() resolves to true and isReady() returns true after successful init', async () => {
    const encoder = new OpusBrowserEncoder();
    const result = await encoder.init();
    expect(result).toBe(true);
    expect(encoder.isReady()).toBe(true);
  });

  it('concurrent calls to init() reuse the same _initPromise — AudioEncoder constructed only once', async () => {
    const encoder = new OpusBrowserEncoder();
    const [r1, r2] = await Promise.all([encoder.init(), encoder.init()]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(MockAudioEncoder).toHaveBeenCalledTimes(1);
  });

  it('calling init() again after already ready short-circuits — AudioEncoder still constructed only once', async () => {
    const encoder = new OpusBrowserEncoder();
    await encoder.init();
    const result = await encoder.init();
    expect(result).toBe(true);
    expect(MockAudioEncoder).toHaveBeenCalledTimes(1);
  });

  it('init() returns false when AudioEncoder is unavailable (not supported browser)', async () => {
    vi.stubGlobal('AudioEncoder', undefined);
    const encoder = new OpusBrowserEncoder();
    const result = await encoder.init();
    expect(result).toBe(false);
    expect(encoder.isReady()).toBe(false);
  });

  it('init() returns false when codec is not supported by the browser', async () => {
    MockAudioEncoder.isConfigSupported = vi.fn().mockResolvedValue({ supported: false });
    const encoder = new OpusBrowserEncoder();
    const result = await encoder.init();
    expect(result).toBe(false);
    expect(encoder.isReady()).toBe(false);
  });

  it('isReady() returns false when the underlying AudioEncoder state is not "configured"', async () => {
    const ClosedEncoder = vi.fn(function () {
      this.state = 'closed';
      this.configure = vi.fn();
      this.encode = vi.fn();
      this.flush = vi.fn();
      this.close = vi.fn();
    });
    ClosedEncoder.isConfigSupported = vi.fn().mockResolvedValue({ supported: true });
    vi.stubGlobal('AudioEncoder', ClosedEncoder);
    const encoder = new OpusBrowserEncoder();
    await encoder.init();
    expect(encoder.isReady()).toBe(false);
  });

  it('destroy() resets state so isReady() returns false', async () => {
    const encoder = new OpusBrowserEncoder();
    await encoder.init();
    expect(encoder.isReady()).toBe(true);
    encoder.destroy();
    expect(encoder.isReady()).toBe(false);
  });

  it('init() can succeed again after destroy()', async () => {
    const encoder = new OpusBrowserEncoder();
    await encoder.init();
    encoder.destroy();
    const result = await encoder.init();
    expect(result).toBe(true);
    expect(encoder.isReady()).toBe(true);
    expect(MockAudioEncoder).toHaveBeenCalledTimes(2);
  });
});
