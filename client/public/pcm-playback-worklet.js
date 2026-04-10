class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ringBuffer = [];
    this._currentFrame = null;
    this._offset = 0;
    this._primed = false;
    this._PRE_BUFFER_FRAMES = 22;
    this._REPRIME_FRAMES = 4;
    this._gain = 1.0;
    this._lastSampleValue = 0;
    this._underrunFading = false;
    this._underrunFadeSamplesLeft = 0;
    this._underrunFadeStart = 0;
    this._UNDERRUN_FADE_SAMPLES = 240;
    this._underrunCount = 0;
    this._lastUnderrunReport = 0;

    this._totalFramesReceived = 0;
    this._totalFramesPlayed = 0;
    this._hasEverPlayed = false;
    this._bufferDepthSum = 0;
    this._bufferDepthSamples = 0;
    this._lastDiagReport = 0;
    this._diagIntervalSec = 2;

    this.port.onmessage = (event) => {
      if (event.data.type === 'enqueue') {
        this._ringBuffer.push(event.data.samples);
        this._totalFramesReceived++;
      } else if (event.data.type === 'clear') {
        this._ringBuffer = [];
        this._currentFrame = null;
        this._offset = 0;
        this._primed = false;
        this._hasEverPlayed = false;
        this._lastSampleValue = 0;
        this._underrunFading = false;
        this._underrunFadeSamplesLeft = 0;
        this._underrunFadeStart = 0;
      } else if (event.data.type === 'setGain') {
        this._gain = event.data.gain;
      }
    };
  }

  _softClip(sample) {
    const abs = Math.abs(sample);
    if (abs < 0.9) return sample;
    const over = abs - 0.9;
    const compressed = 0.9 + over / (1.0 + over * 10.0);
    return sample < 0 ? -compressed : compressed;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const outChannel = output[0];
    const gain = this._gain;

    this._bufferDepthSum += this._ringBuffer.length;
    this._bufferDepthSamples++;

    const now = currentTime;
    if (now - this._lastDiagReport >= this._diagIntervalSec) {
      this._lastDiagReport = now;
      if (this._totalFramesReceived > 0 || this._totalFramesPlayed > 0 || this._underrunCount > 0) {
        const avgDepth = this._bufferDepthSamples > 0
          ? (this._bufferDepthSum / this._bufferDepthSamples).toFixed(1)
          : 0;
        this.port.postMessage({
          type: 'diagnostics',
          framesReceived: this._totalFramesReceived,
          framesPlayed: this._totalFramesPlayed,
          underrunCount: this._underrunCount,
          bufferDepth: this._ringBuffer.length,
          avgBufferDepth: parseFloat(avgDepth),
        });
      }
      this._totalFramesReceived = 0;
      this._totalFramesPlayed = 0;
      this._underrunCount = 0;
      this._bufferDepthSum = 0;
      this._bufferDepthSamples = 0;
    }

    if (this._underrunFading) {
      let i = 0;
      for (; i < outChannel.length; i++) {
        if (this._underrunFadeSamplesLeft > 0) {
          const t = this._underrunFadeSamplesLeft / this._UNDERRUN_FADE_SAMPLES;
          outChannel[i] = this._underrunFadeStart * t;
          this._underrunFadeSamplesLeft--;
        } else {
          break;
        }
      }
      for (; i < outChannel.length; i++) {
        outChannel[i] = 0;
      }
      if (this._underrunFadeSamplesLeft <= 0) {
        this._underrunFading = false;
        this._lastSampleValue = 0;
      }
      return true;
    }

    if (!this._primed) {
      const requiredFrames = this._ringBuffer.length === 0
        ? this._PRE_BUFFER_FRAMES
        : (this._hasEverPlayed ? this._REPRIME_FRAMES : this._PRE_BUFFER_FRAMES);
      if (this._ringBuffer.length < requiredFrames) {
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
      }

      const available = this._currentFrame.length - this._offset;
      const needed = outChannel.length - written;
      const count = Math.min(available, needed);

      for (let i = 0; i < count; i++) {
        let sample = (this._currentFrame[this._offset + i] / 32768) * gain;
        sample = this._softClip(sample);
        outChannel[written + i] = sample;
      }

      written += count;
      this._offset += count;

      if (this._offset >= this._currentFrame.length) {
        this._lastSampleValue = (this._currentFrame[this._currentFrame.length - 1] / 32768) * gain;
        this._currentFrame = null;
        this._offset = 0;
        this._totalFramesPlayed++;
        this._hasEverPlayed = true;
      }
    }

    if (written < outChannel.length) {
      this._underrunFading = true;
      this._underrunFadeSamplesLeft = this._UNDERRUN_FADE_SAMPLES;
      this._underrunFadeStart = this._lastSampleValue;
      this._primed = false;

      for (let i = written; i < outChannel.length; i++) {
        if (this._underrunFadeSamplesLeft > 0) {
          const t = this._underrunFadeSamplesLeft / this._UNDERRUN_FADE_SAMPLES;
          outChannel[i] = this._underrunFadeStart * t;
          this._underrunFadeSamplesLeft--;
        } else {
          outChannel[i] = 0;
        }
      }

      if (this._underrunFadeSamplesLeft <= 0) {
        this._underrunFading = false;
        this._lastSampleValue = 0;
      }

      this._underrunCount++;
      if (now - this._lastUnderrunReport > 2) {
        this._lastUnderrunReport = now;
        this.port.postMessage({
          type: 'underrun',
          count: this._underrunCount,
          bufferDepth: this._ringBuffer.length,
        });
      }
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
