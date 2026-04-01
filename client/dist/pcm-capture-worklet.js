class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Float32Array(0);
    this._frameSamples = 960;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channelData = input[0];
    const merged = new Float32Array(this._buffer.length + channelData.length);
    merged.set(this._buffer, 0);
    merged.set(channelData, this._buffer.length);
    this._buffer = merged;

    while (this._buffer.length >= this._frameSamples) {
      const frame = this._buffer.slice(0, this._frameSamples);
      this._buffer = this._buffer.slice(this._frameSamples);

      const int16 = new Int16Array(this._frameSamples);
      for (let i = 0; i < this._frameSamples; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      this.port.postMessage({ type: 'pcmFrame', samples: int16 }, [int16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
