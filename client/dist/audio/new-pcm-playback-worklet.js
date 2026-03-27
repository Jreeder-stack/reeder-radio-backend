class NewPcmPlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._queueOffset = 0;
    this._maxQueueDepth = 10;
    this._totalEnqueued = 0;
    this._totalPlayed = 0;
    this._underruns = 0;

    this.port.onmessage = (e) => {
      if (e.data.type === 'pcmFrame') {
        const int16 = e.data.samples;
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / 32768;
        }
        this._queue.push(float32);
        this._totalEnqueued++;

        if (this._queue.length > this._maxQueueDepth) {
          const discard = this._queue.length - this._maxQueueDepth;
          this._queue.splice(0, discard);
          this._queueOffset = 0;
        }

        if (this._totalEnqueued % 50 === 0) {
          this.port.postMessage({
            type: 'stats',
            queueDepth: this._queue.length,
            totalEnqueued: this._totalEnqueued,
            totalPlayed: this._totalPlayed,
            underruns: this._underruns,
          });
        }
      } else if (e.data.type === 'reset') {
        this._queue = [];
        this._queueOffset = 0;
        this._totalEnqueued = 0;
        this._totalPlayed = 0;
        this._underruns = 0;
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
        this._totalPlayed++;
      }
    }

    if (written < channel.length) {
      for (let i = written; i < channel.length; i++) {
        channel[i] = 0;
      }
      if (this._totalEnqueued > 0 && written === 0) {
        this._underruns++;
      }
    }

    return true;
  }
}

registerProcessor('new-pcm-playback-processor', NewPcmPlaybackProcessor);
