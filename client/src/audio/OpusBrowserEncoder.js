import OpusScript from 'opusscript';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960;

export class OpusBrowserEncoder {
  constructor() {
    this._encoder = null;
    this._ready = false;
  }

  init() {
    if (this._ready) return;
    try {
      this._encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
      try {
        this._encoder.encoderCTL(4002, 48000);
        this._encoder.encoderCTL(4012, 1);
        this._encoder.encoderCTL(4014, 10);
      } catch (_) {}
      this._ready = true;
    } catch (err) {
      console.error('[OpusBrowserEncoder] Failed to initialize:', err.message);
      this._ready = false;
    }
  }

  isReady() {
    return this._ready;
  }

  encode(int16Frame) {
    if (!this._ready || !this._encoder) return null;
    try {
      const pcmBuf = new Uint8Array(int16Frame.buffer, int16Frame.byteOffset, int16Frame.byteLength);
      const encoded = this._encoder.encode(pcmBuf, FRAME_SIZE);
      return new Uint8Array(encoded);
    } catch (err) {
      console.warn('[OpusBrowserEncoder] Encode error:', err.message);
      return null;
    }
  }

  destroy() {
    if (this._encoder) {
      try { this._encoder.delete(); } catch (_) {}
      this._encoder = null;
    }
    this._ready = false;
  }
}
