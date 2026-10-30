import { opusPacketDurationMs } from './OpusPacketDuration.js';

const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const FRAME_SIZE = 320;
const BITRATE = 32000;
const FRAME_DURATION_US = 20000;
const BASE_CONFIG = { codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: CHANNELS, bitrate: BITRATE };
const VOICE_CONFIG = {
  ...BASE_CONFIG,
  opus: {
    format: 'opus', application: 'voip', signal: 'voice',
    frameDuration: FRAME_DURATION_US, useinbandfec: true,
    packetlossperc: 10, usedtx: false,
  },
};

export class OpusBrowserEncoder {
  constructor() {
    this._encoder = null;
    this._ready = false;
    this._initPromise = null;
    this._frameTimestamp = 0;
    this._onEncoded = null;
    this._outputDiagCount = 0;
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

    this._initPromise = this._doInit().finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  async _doInit() {
    try {
      let config = VOICE_CONFIG;
      let support;
      try {
        support = await AudioEncoder.isConfigSupported(config);
      } catch (_) {
        support = { supported: false };
      }
      if (!support.supported) {
        console.warn('[OpusBrowserEncoder] Voice settings unsupported, using base Opus configuration');
        config = BASE_CONFIG;
        support = await AudioEncoder.isConfigSupported(config);
      }
      if (!support.supported) {
        console.error('[OpusBrowserEncoder] Opus encoding not supported by this browser');
        this._ready = false;
        return false;
      }

      this._encoder = new AudioEncoder({
        output: (chunk) => {
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);
          const packetDurationMs = opusPacketDurationMs(buf);
          const chunkDurationUs = chunk.duration;
          if (packetDurationMs !== FRAME_DURATION_US / 1000 ||
              (Number.isFinite(chunkDurationUs) && chunkDurationUs !== FRAME_DURATION_US)) {
            console.error('AUDIO_TX_BAD_OPUS_DURATION', {
              toc: buf[0], bytes: buf.length, packetDurationMs, chunkDurationUs,
              expectedDurationMs: 20,
            });
            return;
          }
          if (this._outputDiagCount++ < 5) {
            console.log('AUDIO_TX_OPUS_PACKET', {
              bytes: buf.length, toc: buf[0], durationMs: packetDurationMs,
              encoderOutputCount: this._outputDiagCount,
            });
          }
          if (this._onEncoded) {
            this._onEncoded(buf);
          }
        },
        error: (err) => {
          console.error('[OpusBrowserEncoder] Encoder error:', err.message);
        },
      });

      try {
        this._encoder.configure(config);
      } catch (err) {
        if (config === BASE_CONFIG) throw err;
        console.warn('[OpusBrowserEncoder] Voice configure failed, retrying base Opus:', err.message);
        this._encoder.configure(BASE_CONFIG);
      }

      this._ready = true;
      console.log('[OpusBrowserEncoder] WebCodecs AudioEncoder initialized (opus, 16kHz, mono, 20ms)');
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
    if (!int16Frame || int16Frame.length !== FRAME_SIZE) {
      console.error('AUDIO_TX_INVALID_PCM_FRAME', { actualSamples: int16Frame?.length, expectedSamples: FRAME_SIZE });
      return;
    }

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
