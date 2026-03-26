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
    this._inOpusPointer = 0;
    this._outOpusPointer = 0;
    this._outPCMPointer = 0;
    this._ready = false;
  }

  async init() {
    if (this._ready) return;

    this._native = await _loadModule();

    this._encoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);
    this._decoder = new this._native.OpusScriptHandler(SAMPLE_RATE, CHANNELS, APPLICATION_VOIP);

    const inPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._inPCMPointer = this._native._malloc(inPCMLength);

    this._inOpusPointer = this._native._malloc(MAX_PACKET_SIZE);

    this._outOpusPointer = this._native._malloc(MAX_PACKET_SIZE);

    const outPCMLength = MAX_FRAME_SIZE * CHANNELS * 2;
    this._outPCMPointer = this._native._malloc(outPCMLength);

    this._encoder._encoder_ctl(OPUS_SET_BITRATE, 32000);
    this._encoder._encoder_ctl(OPUS_SET_INBAND_FEC, 1);
    this._encoder._encoder_ctl(OPUS_SET_PACKET_LOSS_PERC, 10);

    let selfTestPassed = false;
    try {
      const testPcm = new Int16Array(FRAME_SIZE);
      const testBytes = new Uint8Array(testPcm.buffer);
      this._native.HEAPU8.set(testBytes, this._inPCMPointer);
      const encLen = this._encoder._encode(this._inPCMPointer, testBytes.length, this._outOpusPointer, FRAME_SIZE);
      if (encLen <= 0) {
        console.error('[OpusBrowserCodec] Self-test encode failed, len=' + encLen);
      } else {
        this._native.HEAPU8.set(
          this._native.HEAPU8.subarray(this._outOpusPointer, this._outOpusPointer + encLen),
          this._inOpusPointer
        );
        const decSamples = this._decoder._decode(this._inOpusPointer, encLen, this._outPCMPointer);
        if (decSamples <= 0) {
          console.error('[OpusBrowserCodec] Self-test decode failed, samples=' + decSamples);
        } else {
          console.log('[OpusBrowserCodec] Self-test OK: encoded ' + encLen + ' bytes, decoded ' + decSamples + ' samples');
          selfTestPassed = true;
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
    this._native.HEAPU8.set(pcmBytes, this._inPCMPointer);

    const len = this._encoder._encode(this._inPCMPointer, pcmBytes.length, this._outOpusPointer, FRAME_SIZE);
    if (len < 0) {
      throw new Error('Opus encode error: ' + len);
    }

    const result = new Uint8Array(len);
    result.set(this._native.HEAPU8.subarray(this._outOpusPointer, this._outOpusPointer + len));
    return result;
  }

  decode(opusData) {
    if (!this._ready) throw new Error('OpusBrowserCodec not initialized');

    this._native.HEAPU8.set(opusData, this._inOpusPointer);

    const samples = this._decoder._decode(this._inOpusPointer, opusData.length, this._outPCMPointer);
    if (samples < 0) {
      throw new Error('Opus decode error: ' + samples);
    }

    const pcmByteLen = samples * CHANNELS * 2;
    const raw = new Uint8Array(pcmByteLen);
    raw.set(this._native.HEAPU8.subarray(this._outPCMPointer, this._outPCMPointer + pcmByteLen));
    return new Int16Array(raw.buffer);
  }

  // FEC recovery: ideally calls opus_decode(decoder, nextPacket, len, pcm, frameSize, 1)
  // to extract forward error correction data from the next packet. However, opusscript's
  // compiled handler does not expose the decode_fec parameter (hardcoded to 0). This falls
  // back to PLC (zero-length decode) which uses the decoder's internal state for concealment.
  // To enable true FEC decode, replace with a WASM build that exports decode_fec.
  decodeFEC(nextOpusPacket) {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      const samples = this._decoder._decode(this._inOpusPointer, 0, this._outPCMPointer);
      if (samples > 0) {
        const pcmByteLen = samples * CHANNELS * 2;
        const raw = new Uint8Array(pcmByteLen);
        raw.set(this._native.HEAPU8.subarray(this._outPCMPointer, this._outPCMPointer + pcmByteLen));
        return new Int16Array(raw.buffer);
      }
    } catch (e) {}

    return new Int16Array(FRAME_SIZE);
  }

  decodePLC() {
    if (!this._ready) return new Int16Array(FRAME_SIZE);

    try {
      const samples = this._decoder._decode(this._inOpusPointer, 0, this._outPCMPointer);
      if (samples > 0) {
        const pcmByteLen = samples * CHANNELS * 2;
        const raw = new Uint8Array(pcmByteLen);
        raw.set(this._native.HEAPU8.subarray(this._outPCMPointer, this._outPCMPointer + pcmByteLen));
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
