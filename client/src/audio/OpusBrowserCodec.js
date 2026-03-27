const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960;
const APPLICATION_VOIP = 2048;
const MAX_FRAME_SIZE = 48000 * 60 / 1000;
const MAX_PACKET_SIZE = 1276 * 3;

const OPUS_SET_BITRATE = 4002;
const OPUS_SET_INBAND_FEC = 4012;
const OPUS_SET_PACKET_LOSS_PERC = 4014;

let _modulePromise = null;

function _loadModule() {
  if (!_modulePromise) {
    _modulePromise = (async () => {
      const wasmResponse = await fetch('/audio/opusscript_native_wasm.wasm');
      if (!wasmResponse.ok) throw new Error('Failed to fetch opusscript WASM: ' + wasmResponse.status);
      const wasmBinary = await wasmResponse.arrayBuffer();

      await new Promise((resolve, reject) => {
        const savedModule = window.Module;
        const script = document.createElement('script');
        script.src = '/audio/opusscript_native_wasm.js';
        script.onload = () => {
          window._opusWasmFactory = window.Module;
          window.Module = savedModule;
          resolve();
        };
        script.onerror = () => reject(new Error('Failed to load opusscript WASM JS'));
        document.head.appendChild(script);
      });

      const factory = window._opusWasmFactory;
      delete window._opusWasmFactory;
      if (typeof factory !== 'function') {
        throw new Error('opusscript WASM module factory not found');
      }

      const instance = factory({ wasmBinary });

      if (instance.ready) {
        await instance.ready;
      }

      return instance;
    })();
  }
  return _modulePromise;
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
  }

  async init() {
    if (this._ready) return;
    const t0 = performance.now();
    console.log('[RX-DIAG] OpusBrowserCodec init starting...');

    this._native = await _loadModule();

    this._encoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);
    this._decoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);

    this._inPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._inPCMPointer = this._native._malloc(this._inPCMLength);
    this._inPCM = this._native.HEAP16.subarray(this._inPCMPointer >> 1, (this._inPCMPointer >> 1) + MAX_FRAME_SIZE * CHANNELS);

    this._outPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._outPCMPointer = this._native._malloc(this._outPCMLength);
    this._outPCM = this._native.HEAP16.subarray(this._outPCMPointer >> 1, (this._outPCMPointer >> 1) + MAX_FRAME_SIZE * CHANNELS);

    this._inOpusPointer = this._native._malloc(MAX_PACKET_SIZE);
    this._inOpus = this._native.HEAPU8.subarray(this._inOpusPointer, this._inOpusPointer + MAX_PACKET_SIZE);

    this._outOpusPointer = this._native._malloc(MAX_PACKET_SIZE);
    this._outOpus = this._native.HEAPU8.subarray(this._outOpusPointer, this._outOpusPointer + MAX_PACKET_SIZE);

    this._encoder._encoder_ctl(OPUS_SET_BITRATE, 48000);
    this._encoder._encoder_ctl(OPUS_SET_INBAND_FEC, 1);
    this._encoder._encoder_ctl(OPUS_SET_PACKET_LOSS_PERC, 10);

    let selfTestPassed = false;
    try {
      const testPcm = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        testPcm[i] = Math.round(Math.sin(i * 2 * Math.PI * 440 / SAMPLE_RATE) * 16384);
      }

      this._inPCM.set(testPcm);

      const encLen = this._encoder._encode(this._inPCMPointer, FRAME_SIZE, this._outOpusPointer, MAX_PACKET_SIZE);
      if (encLen <= 0) {
        console.error('[OpusBrowserCodec] Self-test encode failed, len=' + encLen);
      } else {
        const opusCopy = new Uint8Array(this._outOpus.subarray(0, encLen));
        this._inOpus.set(opusCopy);

        const decSamples = this._decoder._decode(this._inOpusPointer, encLen, this._outPCMPointer);
        if (decSamples <= 0) {
          console.error('[OpusBrowserCodec] Self-test decode failed, samples=' + decSamples);
        } else {
          const sampleCount = decSamples * CHANNELS;
          const decoded = new Int16Array(sampleCount);
          decoded.set(new Int16Array(this._native.HEAP16.buffer, this._outPCMPointer, sampleCount));

          let maxVal = 0;
          let sumAbs = 0;
          for (let i = 0; i < Math.min(decoded.length, 100); i++) {
            const v = Math.abs(decoded[i]);
            if (v > maxVal) maxVal = v;
            sumAbs += v;
          }
          const avgAbs = sumAbs / Math.min(decoded.length, 100);

          let dotProduct = 0, normA = 0, normB = 0;
          const checkLen = Math.min(decoded.length, testPcm.length);
          for (let i = 0; i < checkLen; i++) {
            dotProduct += testPcm[i] * decoded[i];
            normA += testPcm[i] * testPcm[i];
            normB += decoded[i] * decoded[i];
          }
          const correlation = (normA > 0 && normB > 0) ? dotProduct / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;

          if (maxVal < 100 || avgAbs < 10) {
            console.error('[OpusBrowserCodec] Self-test FAILED: decoded signal too quiet (max=' + maxVal + ', avg=' + avgAbs.toFixed(1) + ')');
          } else if (correlation < 0.3) {
            console.error('[OpusBrowserCodec] Self-test FAILED: decoded signal does not correlate with input (r=' + correlation.toFixed(3) + '). peak=' + maxVal + ', avg=' + avgAbs.toFixed(1));
          } else {
            console.log('[OpusBrowserCodec] Self-test OK: encoded ' + encLen + ' bytes, decoded ' + decSamples + ' samples, peak=' + maxVal + ', avg=' + avgAbs.toFixed(1) + ', correlation=' + correlation.toFixed(3));
            selfTestPassed = true;
          }
        }
      }
    } catch (e) {
      console.error('[OpusBrowserCodec] Self-test exception:', e.message);
    }

    if (!selfTestPassed) {
      console.error(`[RX-DIAG] OpusBrowserCodec init FAILED (self-test) in ${(performance.now() - t0).toFixed(1)}ms — codec will not be used`);
      this.destroy();
      return;
    }

    this._ready = true;
    console.log(`[RX-DIAG] OpusBrowserCodec init complete in ${(performance.now() - t0).toFixed(1)}ms (48kHz, mono, 960 frame, FEC enabled)`);
  }

  get ready() {
    return this._ready;
  }

  encode(pcmInt16) {
    if (!this._ready) throw new Error('OpusBrowserCodec not initialized');

    this._inPCM.set(pcmInt16);

    const len = this._encoder._encode(this._inPCMPointer, pcmInt16.length, this._outOpusPointer, MAX_PACKET_SIZE);
    if (len < 0) {
      throw new Error('Opus encode error: ' + len);
    }

    const result = new Uint8Array(len);
    result.set(this._outOpus.subarray(0, len));
    return result;
  }

  decode(opusData) {
    if (!this._ready) throw new Error('OpusBrowserCodec not initialized');

    this._inOpus.set(opusData);

    const samples = this._decoder._decode(this._inOpusPointer, opusData.length, this._outPCMPointer);
    if (samples < 0) {
      throw new Error('Opus decode error: ' + samples);
    }

    const sampleCount = samples * CHANNELS;
    const result = new Int16Array(sampleCount);
    result.set(new Int16Array(this._native.HEAP16.buffer, this._outPCMPointer, sampleCount));
    return result;
  }

  decodeFEC(nextOpusPacket) {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      if (nextOpusPacket && nextOpusPacket.length > 0) {
        this._inOpus.set(nextOpusPacket);
        const samples = this._decoder._decode(this._inOpusPointer, nextOpusPacket.length, this._outPCMPointer);
        if (samples > 0) {
          const sampleCount = samples * CHANNELS;
          const result = new Int16Array(sampleCount);
          result.set(new Int16Array(this._native.HEAP16.buffer, this._outPCMPointer, sampleCount));
          return result;
        }
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  decodePLC() {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      const samples = this._decoder._decode(this._inOpusPointer, 0, this._outPCMPointer);
      if (samples > 0) {
        const sampleCount = samples * CHANNELS;
        const result = new Int16Array(sampleCount);
        result.set(new Int16Array(this._native.HEAP16.buffer, this._outPCMPointer, sampleCount));
        return result;
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  destroy() {
    if (this._native) {
      if (this._inPCMPointer) this._native._free(this._inPCMPointer);
      if (this._outPCMPointer) this._native._free(this._outPCMPointer);
      if (this._inOpusPointer) this._native._free(this._inOpusPointer);
      if (this._outOpusPointer) this._native._free(this._outOpusPointer);
      if (this._encoder) { try { this._encoder.delete(); } catch (e) {} }
      if (this._decoder) { try { this._decoder.delete(); } catch (e) {} }
    }
    this._native = null;
    this._encoder = null;
    this._decoder = null;
    this._inPCMPointer = 0;
    this._inPCM = null;
    this._outPCMPointer = 0;
    this._outPCM = null;
    this._inOpusPointer = 0;
    this._inOpus = null;
    this._outOpusPointer = 0;
    this._outOpus = null;
    this._ready = false;
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

export default OpusBrowserCodec;
