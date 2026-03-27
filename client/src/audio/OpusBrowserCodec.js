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
    _modulePromise = new Promise((resolve, reject) => {
      const savedModule = window.Module;
      const script = document.createElement('script');
      script.src = '/audio/opusscript_native_nasm.js';
      script.onload = () => {
        try {
          const factory = window.Module;
          window.Module = savedModule;
          if (typeof factory !== 'function') {
            reject(new Error('opusscript module factory not found'));
            return;
          }
          const instance = factory({ wasmBinary: new ArrayBuffer(0) });
          if (instance.ready) {
            instance.ready.then(() => resolve(instance)).catch(reject);
          } else {
            resolve(instance);
          }
        } catch (err) {
          reject(err);
        }
      };
      script.onerror = () => reject(new Error('Failed to load opusscript asm.js'));
      document.head.appendChild(script);
    });
  }
  return _modulePromise;
}

class OpusBrowserCodec {
  constructor() {
    this._native = null;
    this._encoder = null;
    this._decoder = null;
    this._inPCMPtr = 0;
    this._inOpusPtr = 0;
    this._outOpusPtr = 0;
    this._outPCMPtr = 0;
    this._ready = false;
  }

  async init() {
    if (this._ready) return;

    this._native = await _loadModule();

    this._encoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);
    this._decoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);

    this._inPCMPtr = this._native._malloc(MAX_FRAME_SIZE * CHANNELS * 2);
    this._outPCMPtr = this._native._malloc(MAX_FRAME_SIZE * CHANNELS * 2);
    this._inOpusPtr = this._native._malloc(MAX_PACKET_SIZE);
    this._outOpusPtr = this._native._malloc(MAX_PACKET_SIZE);

    this._encoder._encoder_ctl(OPUS_SET_BITRATE, 48000);
    this._encoder._encoder_ctl(OPUS_SET_INBAND_FEC, 1);
    this._encoder._encoder_ctl(OPUS_SET_PACKET_LOSS_PERC, 10);

    let selfTestPassed = false;
    try {
      const testPcm = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        testPcm[i] = Math.round(Math.sin(i * 2 * Math.PI * 440 / SAMPLE_RATE) * 16384);
      }

      const pcmBytes = new Uint8Array(testPcm.buffer);
      this._native.HEAPU8.set(pcmBytes, this._inPCMPtr);

      const encLen = this._encoder._encode(this._inPCMPtr, MAX_PACKET_SIZE, this._outOpusPtr, FRAME_SIZE);
      if (encLen <= 0) {
        console.error('[OpusBrowserCodec] Self-test encode failed, len=' + encLen);
      } else {
        const opusCopy = new Uint8Array(encLen);
        opusCopy.set(this._native.HEAPU8.subarray(this._outOpusPtr, this._outOpusPtr + encLen));
        this._native.HEAPU8.set(opusCopy, this._inOpusPtr);

        const decSamples = this._decoder._decode(this._inOpusPtr, encLen, this._outPCMPtr);
        if (decSamples <= 0) {
          console.error('[OpusBrowserCodec] Self-test decode failed, samples=' + decSamples);
        } else {
          const decBytes = new Uint8Array(decSamples * CHANNELS * 2);
          decBytes.set(this._native.HEAPU8.subarray(this._outPCMPtr, this._outPCMPtr + decSamples * CHANNELS * 2));
          const decoded = new Int16Array(decBytes.buffer);

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
          } else if (correlation < 0.5) {
            console.error('[OpusBrowserCodec] Self-test FAILED: decoded signal does not correlate with input (r=' + correlation.toFixed(3) + ')');
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
      console.error('[OpusBrowserCodec] Self-test FAILED — codec will not be used, falling back to PCM');
      this.destroy();
      return;
    }

    this._ready = true;
    console.log('[OpusBrowserCodec] Initialized (48kHz, mono, 960 frame, FEC enabled)');
  }

  get ready() {
    return this._ready;
  }

  encode(pcmInt16) {
    if (!this._ready) throw new Error('OpusBrowserCodec not initialized');

    const pcmBytes = new Uint8Array(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.byteLength);
    this._native.HEAPU8.set(pcmBytes, this._inPCMPtr);

    const len = this._encoder._encode(this._inPCMPtr, MAX_PACKET_SIZE, this._outOpusPtr, FRAME_SIZE);
    if (len < 0) {
      throw new Error('Opus encode error: ' + len);
    }

    const result = new Uint8Array(len);
    result.set(this._native.HEAPU8.subarray(this._outOpusPtr, this._outOpusPtr + len));
    return result;
  }

  decode(opusData) {
    if (!this._ready) throw new Error('OpusBrowserCodec not initialized');

    this._native.HEAPU8.set(opusData, this._inOpusPtr);

    const samples = this._decoder._decode(this._inOpusPtr, opusData.length, this._outPCMPtr);
    if (samples < 0) {
      throw new Error('Opus decode error: ' + samples);
    }

    const pcmByteLen = samples * CHANNELS * 2;
    const raw = new Uint8Array(pcmByteLen);
    raw.set(this._native.HEAPU8.subarray(this._outPCMPtr, this._outPCMPtr + pcmByteLen));
    return new Int16Array(raw.buffer);
  }

  decodeFEC(nextOpusPacket) {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      if (nextOpusPacket && nextOpusPacket.length > 0) {
        this._native.HEAPU8.set(nextOpusPacket, this._inOpusPtr);
        const samples = this._decoder._decode(this._inOpusPtr, nextOpusPacket.length, this._outPCMPtr);
        if (samples > 0) {
          const pcmByteLen = samples * CHANNELS * 2;
          const raw = new Uint8Array(pcmByteLen);
          raw.set(this._native.HEAPU8.subarray(this._outPCMPtr, this._outPCMPtr + pcmByteLen));
          return new Int16Array(raw.buffer);
        }
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  decodePLC() {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      const samples = this._decoder._decode(this._inOpusPtr, 0, this._outPCMPtr);
      if (samples > 0) {
        const pcmByteLen = samples * CHANNELS * 2;
        const raw = new Uint8Array(pcmByteLen);
        raw.set(this._native.HEAPU8.subarray(this._outPCMPtr, this._outPCMPtr + pcmByteLen));
        return new Int16Array(raw.buffer);
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  destroy() {
    if (this._native) {
      if (this._inPCMPtr) this._native._free(this._inPCMPtr);
      if (this._outPCMPtr) this._native._free(this._outPCMPtr);
      if (this._inOpusPtr) this._native._free(this._inOpusPtr);
      if (this._outOpusPtr) this._native._free(this._outOpusPtr);
      if (this._encoder) { try { this._encoder.delete(); } catch (e) {} }
      if (this._decoder) { try { this._decoder.delete(); } catch (e) {} }
    }
    this._inPCMPtr = 0;
    this._outPCMPtr = 0;
    this._inOpusPtr = 0;
    this._outOpusPtr = 0;
    this._ready = false;
    console.log('[OpusBrowserCodec] Destroyed');
  }
}

let _sharedInstance = null;

export function getOpusBrowserCodec() {
  if (!_sharedInstance) {
    _sharedInstance = new OpusBrowserCodec();
  }
  return _sharedInstance;
}

export async function initOpusBrowserCodec() {
  const codec = getOpusBrowserCodec();
  await codec.init();
  return codec;
}

export { SAMPLE_RATE, CHANNELS, FRAME_SIZE };
