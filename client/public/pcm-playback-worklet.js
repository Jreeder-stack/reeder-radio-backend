class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ringBuffer = [];
    this._currentFrame = null;
    this._offset = 0;
    this._primed = false;
    this._PRE_BUFFER_FRAMES = 22;
    this._gain = 1.0;
    this._lastFrame = null;
    this._underrunFadeStep = 0;
    this._underrunMaxSteps = 10;
    this._underrunCount = 0;
    this._lastUnderrunReport = 0;

    this.port.onmessage = (event) => {
      if (event.data.type === 'enqueue') {
        this._ringBuffer.push(event.data.samples);
      } else if (event.data.type === 'clear') {
        this._ringBuffer = [];
        this._currentFrame = null;
        this._offset = 0;
        this._primed = false;
        this._lastFrame = null;
        this._underrunFadeStep = 0;
      } else if (event.data.type === 'setGain') {
        this._gain = event.data.gain;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const outChannel = output[0];
    const gain = this._gain;

    if (!this._primed) {
      if (this._ringBuffer.length < this._PRE_BUFFER_FRAMES) {
        for (let i = 0; i < outChannel.length; i++) {
          outChannel[i] = 0;
        }
        return true;
      }
      this._primed = true;
    }

    let written = 0;

    while (written < outChannel.length) {
      if (!this._currentFrame) {
        if (this._ringBuffer.length === 0) {
          break;
        }
        this._currentFrame = this._ringBuffer.shift();
        this._offset = 0;
        this._underrunFadeStep = 0;
      }

      const available = this._currentFrame.length - this._offset;
      const needed = outChannel.length - written;
      const count = Math.min(available, needed);

      for (let i = 0; i < count; i++) {
        let sample = (this._currentFrame[this._offset + i] / 32768) * gain;
        sample = sample / (1.0 + Math.abs(sample));
        outChannel[written + i] = sample;
      }

      written += count;
      this._offset += count;

      if (this._offset >= this._currentFrame.length) {
        this._lastFrame = this._currentFrame;
        this._currentFrame = null;
        this._offset = 0;
      }
    }

    if (written < outChannel.length) {
      if (this._lastFrame && this._underrunFadeStep < this._underrunMaxSteps) {
        this._underrunFadeStep++;
        const t = this._underrunFadeStep / this._underrunMaxSteps;
        const fadeGain = gain * (1.0 - t * t);
        const srcLen = this._lastFrame.length;
        for (let i = written; i < outChannel.length; i++) {
          const srcIdx = (i - written) % srcLen;
          const pos = (i - written) / outChannel.length;
          const microFade = 1.0 - pos * 0.3;
          let sample = (this._lastFrame[srcIdx] / 32768) * fadeGain * microFade;
          sample = sample / (1.0 + Math.abs(sample));
          outChannel[i] = sample;
        }
      } else {
        for (let i = written; i < outChannel.length; i++) {
          outChannel[i] = 0;
        }
      }

      this._underrunCount++;
      const now = currentTime;
      if (now - this._lastUnderrunReport > 2) {
        this._lastUnderrunReport = now;
        this.port.postMessage({
          type: 'underrun',
          count: this._underrunCount,
          bufferDepth: this._ringBuffer.length,
        });
        this._underrunCount = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
