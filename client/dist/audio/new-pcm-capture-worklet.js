class NewPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._frameSize = 960;
    this._sending = false;
    this._frameCount = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') {
        this._sending = true;
        this._frameCount = 0;
        this._buffer = new Float32Array(0);
      }
      if (e.data.type === 'stop') {
        this._sending = false;
        this._buffer = new Float32Array(0);
      }
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
      let rmsSum = 0;
      for (let i = 0; i < this._frameSize; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
        rmsSum += s * s;
      }

      const rms = Math.sqrt(rmsSum / this._frameSize);
      this._frameCount++;

      this.port.postMessage({
        type: 'pcmFrame',
        samples: int16,
        rms,
        frameIndex: this._frameCount,
      }, [int16.buffer]);

      this._buffer = this._buffer.subarray(this._frameSize);
    }

    return true;
  }
}

registerProcessor('new-pcm-capture-processor', NewPcmCaptureProcessor);
