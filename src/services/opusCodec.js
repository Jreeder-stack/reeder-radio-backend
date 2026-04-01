import OpusScript from 'opusscript';

const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_SIZE = 960;
const SENDER_DECODER_IDLE_MS = 10000;

class OpusCodecPool {
  constructor() {
    this._encoders = [];
    this._maxPoolSize = 4;
    this._senderDecoders = new Map();
    this._sweepInterval = setInterval(() => this._sweepIdleDecoders(), 5000);
  }

  _createEncoder() {
    const encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.VOIP);
    try {
      encoder.encoderCTL(4002, 48000);
      encoder.encoderCTL(4012, 1);
      encoder.encoderCTL(4014, 10);
    } catch (e) {
      console.warn('[OpusCodec] Failed to configure encoder:', e.message);
    }
    return encoder;
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

  acquireSenderDecoder(senderId) {
    let entry = this._senderDecoders.get(senderId);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.decoder;
    }
    const decoder = this._createDecoder();
    this._senderDecoders.set(senderId, { decoder, lastUsed: Date.now() });
    return decoder;
  }

  resetSenderDecoder(senderId) {
    const entry = this._senderDecoders.get(senderId);
    if (entry) {
      try { entry.decoder.delete(); } catch (e) {}
      this._senderDecoders.delete(senderId);
    }
  }

  releaseSenderDecoder(senderId) {
    const entry = this._senderDecoders.get(senderId);
    if (entry) {
      try { entry.decoder.delete(); } catch (e) {}
      this._senderDecoders.delete(senderId);
      console.log(`[OpusCodec] Pinned decoder released for sender=${senderId} (active=${this._senderDecoders.size})`);
    }
  }

  _sweepIdleDecoders() {
    const now = Date.now();
    for (const [senderId, entry] of this._senderDecoders) {
      if (now - entry.lastUsed > SENDER_DECODER_IDLE_MS) {
        try { entry.decoder.delete(); } catch (e) {}
        this._senderDecoders.delete(senderId);
        console.log(`[OpusCodec] Idle decoder swept for sender=${senderId}`);
      }
    }
  }

  encodePcmToOpus(pcmInt16Buffer) {
    const encoder = this.acquireEncoder();
    try {
      let aligned = pcmInt16Buffer;
      if (aligned.byteOffset % 2 !== 0) {
        const copy = new Uint8Array(aligned.length);
        copy.set(new Uint8Array(aligned.buffer, aligned.byteOffset, aligned.length));
        aligned = Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
      }
      const samples = new Int16Array(
        aligned.buffer,
        aligned.byteOffset,
        aligned.length / 2
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

  decodeOpusToPcm(opusBuffer, senderId) {
    if (senderId) {
      const decoder = this.acquireSenderDecoder(senderId);
      try {
        const decoded = decoder.decode(opusBuffer);
        return Buffer.from(decoded);
      } catch (e) {
        console.warn(`[OpusCodec] Sender-pinned decode error for ${senderId}:`, e.message);
        this.releaseSenderDecoder(senderId);
        const freshDecoder = this.acquireSenderDecoder(senderId);
        const decoded = freshDecoder.decode(opusBuffer);
        return Buffer.from(decoded);
      }
    }
    const decoder = this._createDecoder();
    try {
      const decoded = decoder.decode(opusBuffer);
      return Buffer.from(decoded);
    } finally {
      try { decoder.delete(); } catch (e) {}
    }
  }

  destroy() {
    clearInterval(this._sweepInterval);
    this._encoders.forEach(e => { try { e.delete(); } catch (_) {} });
    for (const [, entry] of this._senderDecoders) {
      try { entry.decoder.delete(); } catch (_) {}
    }
    this._encoders = [];
    this._senderDecoders.clear();
  }
}

export const opusCodec = new OpusCodecPool();
export { SAMPLE_RATE, CHANNELS, FRAME_SIZE };
