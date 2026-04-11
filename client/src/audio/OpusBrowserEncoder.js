const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_SIZE = 320;
const BITRATE = 64000;

export class OpusBrowserEncoder {
  constructor() {
    this._encoder = null;
    this._ready = false;
    this._initPromise = null;
    this._frameTimestamp = 0;
    this._onEncoded = null;
  }

  static isSupported() {
    return typeof AudioEncoder !== 'undefined';
  }

  setOnEncoded(callback) {
    this._onEncoded = callback;
  }

  async init() {
    if (this._ready) return true;
    if (this._initPromise) return this._initPromise;

    if (!OpusBrowserEncoder.isSupported()) {
      console.error('[OpusBrowserEncoder] WebCodecs AudioEncoder not available in this browser');
      return false;
    }

    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec: 'opus',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: CHANNELS,
        bitrate: BITRATE,
      });

      if (!support.supported) {
        console.error('[OpusBrowserEncoder] Opus encoding not supported by this browser');
        this._ready = false;
        return false;
      }

      this._encoder = new AudioEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          if (this._onEncoded) {
            this._onEncoded(buf);
          }
        },
        error: (err) => {
          console.error('[OpusBrowserEncoder] Encoder error:', err.message);
        },
      });

      this._encoder.configure({
        codec: 'opus',
        sampleRate: SAMPLE_RATE,
        numberOfChannels: CHANNELS,
        bitrate: BITRATE,
      });

      this._ready = true;
      console.log('[OpusBrowserEncoder] WebCodecs AudioEncoder initialized (opus, 16kHz, mono)');
      return true;
    } catch (err) {
      console.error('[OpusBrowserEncoder] Failed to initialize WebCodecs encoder:', err.message);
      this._ready = false;
      return false;
    }
  }

  isReady() {
    return this._ready && this._encoder && this._encoder.state === 'configured';
  }

  encode(int16Frame) {
    if (!this.isReady()) return;

    try {
      const float32 = new Float32Array(int16Frame.length);
      for (let i = 0; i < int16Frame.length; i++) {
        float32[i] = int16Frame[i] / 32768;
      }

      const audioData = new AudioData({
        format: 'f32',
        sampleRate: SAMPLE_RATE,
        numberOfFrames: float32.length,
        numberOfChannels: CHANNELS,
        timestamp: this._frameTimestamp,
        data: float32,
      });

      this._frameTimestamp += (float32.length / SAMPLE_RATE) * 1_000_000;

      this._encoder.encode(audioData);
      audioData.close();
    } catch (err) {
      console.warn('[OpusBrowserEncoder] Encode error:', err.message);
    }
  }

  async flush() {
    if (!this.isReady()) return;
    try {
      await this._encoder.flush();
    } catch (err) {
      console.warn('[OpusBrowserEncoder] Flush error:', err.message);
    }
  }

  destroy() {
    if (this._encoder) {
      try {
        if (this._encoder.state !== 'closed') {
          this._encoder.close();
        }
      } catch (_) {}
      this._encoder = null;
    }
    this._ready = false;
    this._frameTimestamp = 0;
    this._initPromise = null;
    this._onEncoded = null;
  }
}
