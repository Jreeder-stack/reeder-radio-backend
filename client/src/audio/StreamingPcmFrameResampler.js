/**
 * Converts microphone AudioContext samples into 16 kHz mono, 20 ms PCM frames.
 * AudioContext sampleRate is not guaranteed to match getUserMedia constraints.
 * Keep the fractional sample position between callbacks to avoid drift.
 */
export class StreamingPcmFrameResampler {
  constructor(sourceSampleRate, targetSampleRate = 16000, frameSamples = 320) {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) {
      throw new Error('Invalid source sample rate');
    }
    this.sourceSampleRate = sourceSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.frameSamples = frameSamples;
    this._step = sourceSampleRate / targetSampleRate;
    this._sourceIndex = 0;
    this._nextOutputIndex = 0;
    this._lastFiltered = 0;
    this._filterReady = false;
    // Remove high-frequency energy before downsampling (voice passband).
    const cutoff = 0.43 * targetSampleRate;
    this._filterAlpha = sourceSampleRate > targetSampleRate
      ? (2 * Math.PI * cutoff) / (sourceSampleRate + 2 * Math.PI * cutoff)
      : 1;
    this._frame = new Int16Array(frameSamples);
    this._frameOffset = 0;
  }

  _emit(value, onFrame) {
    const s = Math.max(-1, Math.min(1, value));
    this._frame[this._frameOffset++] = s < 0 ? s * 32768 : s * 32767;
    if (this._frameOffset === this.frameSamples) {
      onFrame(this._frame);
      this._frame = new Int16Array(this.frameSamples);
      this._frameOffset = 0;
    }
  }

  push(samples, onFrame) {
    for (let i = 0; i < samples.length; i++) {
      const input = Number.isFinite(samples[i]) ? samples[i] : 0;
      if (!this._filterReady) {
        this._lastFiltered = input;
        this._filterReady = true;
      }
      const filtered = this._lastFiltered + this._filterAlpha * (input - this._lastFiltered);
      const sourceIndex = this._sourceIndex++;

      if (sourceIndex === 0) {
        this._emit(filtered, onFrame);
        this._nextOutputIndex += this._step;
      } else {
        while (this._nextOutputIndex <= sourceIndex + 1e-8) {
          const fraction = this._nextOutputIndex - (sourceIndex - 1);
          this._emit(this._lastFiltered + (filtered - this._lastFiltered) * fraction, onFrame);
          this._nextOutputIndex += this._step;
        }
      }
      this._lastFiltered = filtered;
    }
  }
}
