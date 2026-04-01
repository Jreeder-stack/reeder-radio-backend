class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._ringBuffer = [];
    this._currentFrame = null;
    this._offset = 0;
    this._primed = false;
    this._PRE_BUFFER_FRAMES = 3;

    this.port.onmessage = (event) => {
      if (event.data.type === 'enqueue') {
        this._ringBuffer.push(event.data.samples);
      } else if (event.data.type === 'clear') {
        this._ringBuffer = [];
        this._currentFrame = null;
        this._offset = 0;
        this._primed = false;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const outChannel = output[0];

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
      }

      const available = this._currentFrame.length - this._offset;
      const needed = outChannel.length - written;
      const count = Math.min(available, needed);

      for (let i = 0; i < count; i++) {
        outChannel[written + i] = this._currentFrame[this._offset + i] / 32768;
      }

      written += count;
      this._offset += count;

      if (this._offset >= this._currentFrame.length) {
        this._currentFrame = null;
        this._offset = 0;
      }
    }

    for (let i = written; i < outChannel.length; i++) {
      outChannel[i] = 0;
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
