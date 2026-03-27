const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960; // 20ms @ 48kHz
const MAX_FRAME_SIZE = 960;
const MAX_PACKET_SIZE = 1500;
const APPLICATION_VOIP = 2048;

// Encoder CTLs
const OPUS_SET_BITRATE = 4002;
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;

let _modulePromise = null;

async function _loadModule() {
  if (!_modulePromise) {
    _modulePromise = (async () => {
      const moduleFactory = await import('./opus/opus-script-package.js');
      const factory = moduleFactory?.default || moduleFactory;

      const instance = await factory();
      if (instance?.ready && typeof instance.ready.then === 'function') {
        await instance.ready;
      }

      return instance;
    })();
  }
  return _modulePromise;
}

function _copyPcmFromHeap(native, pcmPointer, sampleCount) {
  return new Int16Array(native.HEAP16.buffer, pcmPointer, sampleCount);
}

class OpusBrowserCodec {
  constructor() {
    this._native = null;
    this._encoder = null;
    this._decoder = null;

    this._inPCMLength = 0;
    this._inPCMPointer = 0;
    this._inPCM = null;

    this._outPCMLength = 0;
    this._outPCMPointer = 0;
    this._outPCM = null;

    this._inOpusPointer = 0;
    this._inOpus = null;

    this._outOpusPointer = 0;
    this._outOpus = null;

    this._ready = false;
    this._destroyed = false;
  }

  get ready() {
    return !!this._ready;
  }

  _assertNotDestroyed() {
    if (this._destroyed) {
      throw new Error('OpusBrowserCodec was destroyed');
    }
  }

  _assertReady() {
    if (!this._ready || !this._encoder || !this._decoder || !this._native) {
      throw new Error('OpusBrowserCodec not initialized');
    }
  }

  async init() {
    this._assertNotDestroyed();
    if (this._ready) return;

    const t0 = performance.now();
    console.log('[RX-DIAG] OpusBrowserCodec init starting...');

    this._native = await _loadModule();

    this._encoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);
    this._decoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);

    this._inPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._inPCMPointer = this._native._malloc(this._inPCMLength);
    this._inPCM = this._native.HEAP16.subarray(
      this._inPCMPointer >> 1,
      (this._inPCMPointer >> 1) + MAX_FRAME_SIZE * CHANNELS
    );

    this._outPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._outPCMPointer = this._native._malloc(this._outPCMLength);
    this._outPCM = this._native.HEAP16.subarray(
      this._outPCMPointer >> 1,
      (this._outPCMPointer >> 1) + MAX_FRAME_SIZE * CHANNELS
    );

    this._inOpusPointer = this._native._malloc(MAX_PACKET_SIZE);
    this._inOpus = this._native.HEAPU8.subarray(
      this._inOpusPointer,
      this._inOpusPointer + MAX_PACKET_SIZE
    );

    this._outOpusPointer = this._native._malloc(MAX_PACKET_SIZE);
    this._outOpus = this._native.HEAPU8.subarray(
      this._outOpusPointer,
      this._outOpusPointer + MAX_PACKET_SIZE
    );

    this._encoder._encoder_ctl(OPUS_SET_BITRATE, 48000);
    this._encoder._encoder_ctl(OPUS_SET_INBAND_FEC, 1);
    this._encoder._encoder_ctl(OPUS_SET_PACKET_LOSS_PERC, 10);

    let selfTestPassed = false;

    try {
      const testPcm = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        testPcm[i] = Math.round(
          Math.sin(i * 2 * Math.PI * 440 / SAMPLE_RATE) * 16384
        );
      }

      this._inPCM.fill(0);
      this._inPCM.set(testPcm);

      // KEEPING your current call order for the first test:
      // _encode(pcmPtr, maxPacketSize, outPtr, frameSize)
      const encLen = this._encoder._encode(
        this._inPCMPointer,
        MAX_PACKET_SIZE,
        this._outOpusPointer,
        FRAME_SIZE
      );

      if (encLen <= 0) {
        console.error('[OpusBrowserCodec] Self-test encode failed, len=' + encLen);
      } else {
        const opusCopy = new Uint8Array(this._outOpus.subarray(0, encLen));
        this._inOpus.fill(0);
        this._inOpus.set(opusCopy);

        const decSamples = this._decoder._decode(
          this._inOpusPointer,
          encLen,
          this._outPCMPointer
        );

        if (decSamples <= 0) {
          console.error('[OpusBrowserCodec] Self-test decode failed, samples=' + decSamples);
        } else {
          const sampleCount = decSamples * CHANNELS;
          const decoded = new Int16Array(sampleCount);
          decoded.set(_copyPcmFromHeap(this._native, this._outPCMPointer, sampleCount));

          let maxVal = 0;
          let sumAbs = 0;
          const inspectLen = Math.min(decoded.length, 100);

          for (let i = 0; i < inspectLen; i++) {
            const v = Math.abs(decoded[i]);
            if (v > maxVal) maxVal = v;
            sumAbs += v;
          }

          const avgAbs = inspectLen > 0 ? (sumAbs / inspectLen) : 0;

          let dotProduct = 0;
          let normA = 0;
          let normB = 0;
          const checkLen = Math.min(decoded.length, testPcm.length);

          for (let i = 0; i < checkLen; i++) {
            dotProduct += testPcm[i] * decoded[i];
            normA += testPcm[i] * testPcm[i];
            normB += decoded[i] * decoded[i];
          }

          const correlation =
            normA > 0 && normB > 0
              ? dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
              : 0;

          if (maxVal < 100 || avgAbs < 10) {
            console.error(
              '[OpusBrowserCodec] Self-test FAILED: decoded signal too quiet (max=' +
                maxVal +
                ', avg=' +
                avgAbs.toFixed(1) +
                ')'
            );
          } else if (correlation < 0.3) {
            console.error(
              '[OpusBrowserCodec] Self-test FAILED: decoded signal does not correlate with input (r=' +
                correlation.toFixed(3) +
                '). peak=' +
                maxVal +
                ', avg=' +
                avgAbs.toFixed(1)
            );
          } else {
            console.log(
              '[OpusBrowserCodec] Self-test OK: encoded ' +
                encLen +
                ' bytes, decoded ' +
                decSamples +
                ' samples, peak=' +
                maxVal +
                ', avg=' +
                avgAbs.toFixed(1) +
                ', correlation=' +
                correlation.toFixed(3)
            );
            selfTestPassed = true;
          }
        }
      }
    } catch (e) {
      console.error('[OpusBrowserCodec] Self-test exception:', e?.message || e);
    }

    if (!selfTestPassed) {
      console.error(
        `[RX-DIAG] OpusBrowserCodec init FAILED (self-test) in ${(performance.now() - t0).toFixed(1)}ms — codec will not be used`
      );
      this.destroy();
      return;
    }

    this._ready = true;
    console.log(
      `[RX-DIAG] OpusBrowserCodec init complete in ${(performance.now() - t0).toFixed(1)}ms (48kHz, mono, 960 frame, FEC enabled)`
    );
  }

  encode(pcmInt16) {
    this._assertNotDestroyed();
    this._assertReady();

    if (!(pcmInt16 instanceof Int16Array)) {
      throw new Error('encode() expects Int16Array');
    }

    if (pcmInt16.length <= 0) {
      throw new Error('encode() received empty PCM frame');
    }

    if (pcmInt16.length > MAX_FRAME_SIZE * CHANNELS) {
      throw new Error(
        `encode() frame too large: ${pcmInt16.length} samples (max ${MAX_FRAME_SIZE * CHANNELS})`
      );
    }

    this._inPCM.fill(0);
    this._inPCM.set(pcmInt16);

    const len = this._encoder._encode(
      this._inPCMPointer,
      MAX_PACKET_SIZE,
      this._outOpusPointer,
      pcmInt16.length
    );

    if (len < 0) {
      throw new Error('Opus encode error: ' + len);
    }

    const result = new Uint8Array(len);
    result.set(this._outOpus.subarray(0, len));
    return result;
  }

  decode(opusData) {
    this._assertNotDestroyed();
    this._assertReady();

    if (!(opusData instanceof Uint8Array)) {
      throw new Error('decode() expects Uint8Array');
    }

    if (opusData.length <= 0) {
      throw new Error('decode() received empty opus packet');
    }

    if (opusData.length > MAX_PACKET_SIZE) {
      throw new Error(
        `decode() packet too large: ${opusData.length} bytes (max ${MAX_PACKET_SIZE})`
      );
    }

    this._inOpus.fill(0);
    this._inOpus.set(opusData);

    const samples = this._decoder._decode(
      this._inOpusPointer,
      opusData.length,
      this._outPCMPointer
    );

    if (samples < 0) {
      throw new Error('Opus decode error: ' + samples);
    }

    const sampleCount = samples * CHANNELS;
    const result = new Int16Array(sampleCount);
    result.set(_copyPcmFromHeap(this._native, this._outPCMPointer, sampleCount));
    return result;
  }

  decodeFEC(nextOpusPacket) {
    if (!this._ready || !this._decoder || !this._native) {
      return new Int16Array(FRAME_SIZE);
    }

    try {
      if (nextOpusPacket && nextOpusPacket.length > 0) {
        if (nextOpusPacket.length > MAX_PACKET_SIZE) {
          return new Int16Array(FRAME_SIZE);
        }

        this._inOpus.fill(0);
        this._inOpus.set(nextOpusPacket);

        const samples = this._decoder._decode(
          this._inOpusPointer,
          nextOpusPacket.length,
          this._outPCMPointer
        );

        if (samples > 0) {
          const sampleCount = samples * CHANNELS;
          const result = new Int16Array(sampleCount);
          result.set(_copyPcmFromHeap(this._native, this._outPCMPointer, sampleCount));
          return result;
        }
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  decodePLC() {
    if (!this._ready || !this._decoder || !this._native) {
      return new Int16Array(FRAME_SIZE);
    }

    try {
      const samples = this._decoder._decode(
        this._inOpusPointer,
        0,
        this._outPCMPointer
      );

      if (samples > 0) {
        const sampleCount = samples * CHANNELS;
        const result = new Int16Array(sampleCount);
        result.set(_copyPcmFromHeap(this._native, this._outPCMPointer, sampleCount));
        return result;
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  destroy() {
    try {
      if (this._native) {
        if (this._inPCMPointer) this._native._free(this._inPCMPointer);
        if (this._outPCMPointer) this._native._free(this._outPCMPointer);
        if (this._inOpusPointer) this._native._free(this._inOpusPointer);
        if (this._outOpusPointer) this._native._free(this._outOpusPointer);
      }
    } catch (e) {}

    try {
      if (this._encoder) this._encoder.delete();
    } catch (e) {}

    try {
      if (this._decoder) this._decoder.delete();
    } catch (e) {}

    this._native = null;
    this._encoder = null;
    this._decoder = null;

    this._inPCMLength = 0;
    this._inPCMPointer = 0;
    this._inPCM = null;

    this._outPCMLength = 0;
    this._outPCMPointer = 0;
    this._outPCM = null;

    this._inOpusPointer = 0;
    this._inOpus = null;

    this._outOpusPointer = 0;
    this._outOpus = null;

    this._ready = false;
    this._destroyed = true;
  }
}

let _singletonCodec = null;
let _initFailed = false;

export async function initOpusBrowserCodec() {
  if (_initFailed) {
    throw new Error('OpusBrowserCodec initialization previously failed (self-test)');
  }

  if (!_singletonCodec) {
    _singletonCodec = new OpusBrowserCodec();
  }

  if (!_singletonCodec || !_singletonCodec.ready) {
    await _singletonCodec.init();
  }

  if (!_singletonCodec || !_singletonCodec.ready) {
    _singletonCodec = null;
    _initFailed = true;
    throw new Error('OpusBrowserCodec initialization failed (self-test)');
  }

  return _singletonCodec;
}

export function getOpusBrowserCodec() {
  return _singletonCodec;
}

export function resetOpusBrowserCodec() {
  try {
    if (_singletonCodec) {
      _singletonCodec.destroy();
    }
  } catch (e) {}

  _singletonCodec = null;
  _initFailed = false;
}

export default OpusBrowserCodec;
