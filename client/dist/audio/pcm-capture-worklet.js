class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._frameSize = 960;
    this._sending = false;
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') this._sending = true;
      if (e.data.type === 'stop') this._sending = false;
    };
  }

  process(inputs, outputs, parameters) {
    if (!this._sending) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    const newBuf = new Float32Array(this._buffer.length + channel.length);
    newBuf.set(this._buffer);
    newBuf.set(channel, this._buffer.length);
    this._buffer = newBuf;

    while (this._buffer.length >= this._frameSize) {
      const frame = this._buffer.subarray(0, this._frameSize);
      const int16 = new Int16Array(this._frameSize);
      for (let i = 0; i < this._frameSize; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage({ type: 'pcm', samples: int16 }, [int16.buffer]);
      this._buffer = this._buffer.subarray(this._frameSize);
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
