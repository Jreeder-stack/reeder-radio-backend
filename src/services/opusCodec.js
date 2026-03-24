import OpusScript from 'opusscript';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960;

class OpusCodecPool {
  constructor() {
    this._encoders = [];
    this._decoders = [];
    this._maxPoolSize = 4;
  }

  _createEncoder() {
    return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  }

  _createDecoder() {
    return new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
  }

  acquireEncoder() {
    return this._encoders.pop() || this._createEncoder();
  }

  releaseEncoder(encoder) {
    if (this._encoders.length < this._maxPoolSize) {
      this._encoders.push(encoder);
    } else {
      try { encoder.delete(); } catch (e) {}
    }
  }

  acquireDecoder() {
    return this._decoders.pop() || this._createDecoder();
  }

  releaseDecoder(decoder) {
    if (this._decoders.length < this._maxPoolSize) {
      this._decoders.push(decoder);
    } else {
      try { decoder.delete(); } catch (e) {}
    }
  }

  encodePcmToOpus(pcmInt16Buffer) {
    const encoder = this.acquireEncoder();
    try {
      const samples = new Int16Array(
        pcmInt16Buffer.buffer,
        pcmInt16Buffer.byteOffset,
        pcmInt16Buffer.length / 2
      );
      const frames = [];
      for (let offset = 0; offset < samples.length; offset += FRAME_SIZE) {
        const frameLen = Math.min(FRAME_SIZE, samples.length - offset);
        let frame = samples.slice(offset, offset + frameLen);
        if (frame.length < FRAME_SIZE) {
          const padded = new Int16Array(FRAME_SIZE);
          padded.set(frame);
          frame = padded;
        }
        const pcmBuf = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
        const encoded = encoder.encode(pcmBuf, FRAME_SIZE);
        frames.push(Buffer.from(encoded));
      }
      return frames;
    } finally {
      this.releaseEncoder(encoder);
    }
  }

  decodeOpusToPcm(opusBuffer) {
    const decoder = this.acquireDecoder();
    try {
      const decoded = decoder.decode(opusBuffer);
      return Buffer.from(decoded);
    } finally {
      this.releaseDecoder(decoder);
    }
  }

  destroy() {
    this._encoders.forEach(e => { try { e.delete(); } catch (_) {} });
    this._decoders.forEach(d => { try { d.delete(); } catch (_) {} });
    this._encoders = [];
    this._decoders = [];
  }
}

export const opusCodec = new OpusCodecPool();
export { SAMPLE_RATE, CHANNELS, FRAME_SIZE };
