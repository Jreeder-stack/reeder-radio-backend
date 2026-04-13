class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ringBuffer = [];
    this._currentFrame = null;
    this._offset = 0;
    this._primed = false;
    this._PRE_BUFFER_FRAMES = 50;
    this._REPRIME_FRAMES = 25;
    this._gain = 1.0;
    this._lastSampleValue = 0;
    this._underrunFading = false;
    this._underrunFadeSamplesLeft = 0;
    this._underrunFadeStart = 0;
    this._UNDERRUN_FADE_SAMPLES = 240;
    this._underrunCount = 0;
    this._lastUnderrunReport = 0;

    this._TARGET_BUFFER_DEPTH = 25;
    this._smoothedDepth = 0;
    this._smoothAlpha = 0.15;
    this._MAX_STRETCH_RATIO = 0.05;
    this._MAX_COMPRESS_RATIO = 0.05;
    this._stretchAccumulator = 0;
    this._skipAccumulator = 0;

    this._draining = false;

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
        this._draining = false;
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
        this._draining = false;
        this._smoothedDepth = 0;
      } else if (event.data.type === 'drain') {
        this._draining = true;
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

    const currentDepth = this._ringBuffer.length + (this._currentFrame ? 1 : 0);
    this._bufferDepthSum += currentDepth;
    this._bufferDepthSamples++;

    this._smoothedDepth += this._smoothAlpha * (currentDepth - this._smoothedDepth);

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
          smoothedDepth: this._smoothedDepth.toFixed(1),
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

    if (!this._primed && !this._draining) {
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
      this._smoothedDepth = this._TARGET_BUFFER_DEPTH;
    }

    let stretchRatio = 0;
    let compressRatio = 0;
    if (!this._draining) {
      const depthError = this._TARGET_BUFFER_DEPTH - this._smoothedDepth;
      if (depthError > 5) {
        stretchRatio = Math.min(depthError / this._TARGET_BUFFER_DEPTH, this._MAX_STRETCH_RATIO);
      } else if (depthError < -5) {
        compressRatio = Math.min(-depthError / this._TARGET_BUFFER_DEPTH, this._MAX_COMPRESS_RATIO);
      }
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

      while (written < outChannel.length && this._offset < this._currentFrame.length) {
        let sample = (this._currentFrame[this._offset] / 32768) * gain;
        sample = this._softClip(sample);
        outChannel[written] = sample;
        written++;

        if (stretchRatio > 0) {
          this._stretchAccumulator += stretchRatio;
          while (this._stretchAccumulator >= 1.0 && written < outChannel.length) {
            outChannel[written] = sample;
            written++;
            this._stretchAccumulator -= 1.0;
          }
        } else {
          this._stretchAccumulator = 0;
        }

        if (compressRatio > 0) {
          this._skipAccumulator += compressRatio;
          while (this._skipAccumulator >= 1.0) {
            this._offset++;
            this._skipAccumulator -= 1.0;
            if (this._offset >= this._currentFrame.length) break;
          }
        } else {
          this._skipAccumulator = 0;
        }

        this._offset++;
      }

      if (this._offset >= this._currentFrame.length) {
        this._lastSampleValue = (this._currentFrame[this._currentFrame.length - 1] / 32768) * gain;
        this._currentFrame = null;
        this._offset = 0;
        this._totalFramesPlayed++;
        this._hasEverPlayed = true;
      }
    }

    if (written < outChannel.length) {
      if (this._draining || !this._hasEverPlayed) {
        for (let i = written; i < outChannel.length; i++) {
          outChannel[i] = 0;
        }
        if (this._draining && this._ringBuffer.length === 0 && !this._currentFrame) {
          this._draining = false;
          this._primed = false;
          this._smoothedDepth = 0;
          this.port.postMessage({ type: 'drain_complete' });
        }
      } else {
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
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
