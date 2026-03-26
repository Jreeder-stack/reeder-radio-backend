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
    this._inPCMPointer = 0;
    this._inPCM = null;
    this._inOpusPointer = 0;
    this._inOpus = null;
    this._outOpusPointer = 0;
    this._outOpus = null;
    this._outPCMPointer = 0;
    this._outPCM = null;
    this._ready = false;
  }

  async init() {
    if (this._ready) return;

    this._native = await _loadModule();

    this._encoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);
    this._decoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);

    const inPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._inPCMPointer = this._native._malloc(inPCMLength);
    this._inPCM = this._native.HEAPU16.subarray(this._inPCMPointer >> 1, (this._inPCMPointer + inPCMLength) >> 1);

    this._inOpusPointer = this._native._malloc(MAX_PACKET_SIZE);
    this._inOpus = this._native.HEAPU8.subarray(this._inOpusPointer, this._inOpusPointer + MAX_PACKET_SIZE);

    this._outOpusPointer = this._native._malloc(MAX_PACKET_SIZE);
    this._outOpus = this._native.HEAPU8.subarray(this._outOpusPointer, this._outOpusPointer + MAX_PACKET_SIZE);

    const outPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._outPCMPointer = this._native._malloc(outPCMLength);
    this._outPCM = this._native.HEAPU16.subarray(this._outPCMPointer >> 1, (this._outPCMPointer + outPCMLength) >> 1);

    this._encoder._encoder_ctl(OPUS_SET_BITRATE, 48000);
    this._encoder._encoder_ctl(OPUS_SET_INBAND_FEC, 1);
    this._encoder._encoder_ctl(OPUS_SET_PACKET_LOSS_PERC, 10);

    let selfTestPassed = false;
    try {
      const testPcm = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        testPcm[i] = Math.sin(i * 2 * Math.PI * 440 / SAMPLE_RATE) * 16384;
      }
      const testBuf = new Uint16Array(testPcm.buffer);
      this._inPCM.set(testBuf);

      const encLen = this._encoder._encode(this._inPCM.byteOffset, testBuf.length, this._outOpusPointer, FRAME_SIZE);
      if (encLen <= 0) {
        console.error('[OpusBrowserCodec] Self-test encode failed, len=' + encLen);
      } else {
        this._inOpus.set(this._outOpus.subarray(0, encLen));

        const decSamples = this._decoder._decode(this._inOpusPointer, encLen, this._outPCM.byteOffset);
        if (decSamples <= 0) {
          console.error('[OpusBrowserCodec] Self-test decode failed, samples=' + decSamples);
        } else {
          const decoded = new Int16Array(this._outPCM.buffer, this._outPCM.byteOffset, decSamples * CHANNELS);
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
            console.error('[OpusBrowserCodec] Self-test FAILED: decoded signal too quiet (max=' + maxVal + ', avg=' + avgAbs.toFixed(1) + '). Codec may be broken.');
          } else if (correlation < 0.5) {
            console.error('[OpusBrowserCodec] Self-test FAILED: decoded signal does not correlate with input (r=' + correlation.toFixed(3) + '). Possible memory corruption.');
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

    const buf = new Uint16Array(pcmInt16.buffer, pcmInt16.byteOffset, pcmInt16.length);
    this._inPCM.set(buf);

    const len = this._encoder._encode(this._inPCM.byteOffset, buf.length, this._outOpusPointer, FRAME_SIZE);
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

    const samples = this._decoder._decode(this._inOpusPointer, opusData.length, this._outPCM.byteOffset);
    if (samples < 0) {
      throw new Error('Opus decode error: ' + samples);
    }

    const pcmByteLen = samples * CHANNELS * 2;
    const raw = new Uint8Array(pcmByteLen);
    raw.set(new Uint8Array(this._outPCM.buffer, this._outPCM.byteOffset, pcmByteLen));
    return new Int16Array(raw.buffer);
  }

  decodeFEC(nextOpusPacket) {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      this._inOpus.set(nextOpusPacket);
      const samples = this._decoder._decode(this._inOpusPointer, nextOpusPacket.length, this._outPCM.byteOffset);
      if (samples > 0) {
        const pcmByteLen = samples * CHANNELS * 2;
        const raw = new Uint8Array(pcmByteLen);
        raw.set(new Uint8Array(this._outPCM.buffer, this._outPCM.byteOffset, pcmByteLen));
        return new Int16Array(raw.buffer);
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  decodePLC() {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      const samples = this._decoder._decode(this._inOpusPointer, 0, this._outPCM.byteOffset);
      if (samples > 0) {
        const pcmByteLen = samples * CHANNELS * 2;
        const raw = new Uint8Array(pcmByteLen);
        raw.set(new Uint8Array(this._outPCM.buffer, this._outPCM.byteOffset, pcmByteLen));
        return new Int16Array(raw.buffer);
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  destroy() {
    if (this._native) {
      if (this._inPCMPointer) this._native._free(this._inPCMPointer);
      if (this._inOpusPointer) this._native._free(this._inOpusPointer);
      if (this._outOpusPointer) this._native._free(this._outOpusPointer);
      if (this._outPCMPointer) this._native._free(this._outPCMPointer);
      if (this._encoder) { try { this._encoder.delete(); } catch (e) {} }
      if (this._decoder) { try { this._decoder.delete(); } catch (e) {} }
    }
    this._inPCM = null;
    this._inOpus = null;
    this._outOpus = null;
    this._outPCM = null;
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
