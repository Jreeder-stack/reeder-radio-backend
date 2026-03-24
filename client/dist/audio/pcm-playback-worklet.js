class PcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._queueOffset = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'pcm') {
        const int16 = e.data.samples;
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        this._queue.push(float32);
      }
    };
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const channel = output[0];
    let written = 0;

    while (written < channel.length && this._queue.length > 0) {
      const chunk = this._queue[0];
      const available = chunk.length - this._queueOffset;
      const needed = channel.length - written;
      const toCopy = Math.min(available, needed);

      channel.set(chunk.subarray(this._queueOffset, this._queueOffset + toCopy), written);
      written += toCopy;
      this._queueOffset += toCopy;

      if (this._queueOffset >= chunk.length) {
        this._queue.shift();
        this._queueOffset = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-playback-processor', PcmPlaybackProcessor);
