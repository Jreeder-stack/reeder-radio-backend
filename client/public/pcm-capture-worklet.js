class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._frameSamples = 320; // 20 ms at 16 kHz, independent of AudioContext rate
    this._targetRate = 16000;
    this._sourceRate = typeof sampleRate === 'number' && sampleRate > 0 ? sampleRate : this._targetRate;
    this._step = this._sourceRate / this._targetRate;
    this._sourceIndex = 0;
    this._nextOutputIndex = 0;
    this._lastFiltered = 0;
    this._filterReady = false;
    const cutoff = 0.43 * this._targetRate;
    this._filterAlpha = this._sourceRate > this._targetRate
      ? (2 * Math.PI * cutoff) / (this._sourceRate + 2 * Math.PI * cutoff)
      : 1;
    this._frame = new Int16Array(this._frameSamples);
    this._frameOffset = 0;
    this.port.postMessage({ type: 'captureConfig', sourceSampleRate: this._sourceRate, targetSampleRate: this._targetRate });
  }

  _emit(value) {
    const s = Math.max(-1, Math.min(1, value));
    this._frame[this._frameOffset++] = s < 0 ? s * 32768 : s * 32767;
    if (this._frameOffset === this._frameSamples) {
      const frame = this._frame;
      this._frame = new Int16Array(this._frameSamples);
      this._frameOffset = 0;
      this.port.postMessage({ type: 'pcmFrame', samples: frame }, [frame.buffer]);
    }
  }

  process(inputs, outputs) {
    // This node is connected for AudioWorklet scheduling, not mic monitoring.
    if (outputs?.[0]) {
      for (const channel of outputs[0]) channel.fill(0);
    }
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    for (const raw of input[0]) {
      const value = Number.isFinite(raw) ? raw : 0;
      if (!this._filterReady) {
        this._lastFiltered = value;
        this._filterReady = true;
      }
      const filtered = this._lastFiltered + this._filterAlpha * (value - this._lastFiltered);
      const sourceIndex = this._sourceIndex++;
      if (sourceIndex === 0) {
        this._emit(filtered);
        this._nextOutputIndex += this._step;
      } else {
        while (this._nextOutputIndex <= sourceIndex + 1e-8) {
          const fraction = this._nextOutputIndex - (sourceIndex - 1);
          this._emit(this._lastFiltered + (filtered - this._lastFiltered) * fraction);
          this._nextOutputIndex += this._step;
        }
      }
      this._lastFiltered = filtered;
    }
    return true;
  }
}

registerProcessor('pcm-capture-processor', PcmCaptureProcessor);
