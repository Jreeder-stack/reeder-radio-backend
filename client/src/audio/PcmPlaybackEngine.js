import { PCM_SPEC } from './PcmPacket.js';

export class PcmPlaybackEngine {
  constructor() {
    this.audioContext = null;
    this.processor = null;
    this.queue = [];
    this.offset = 0;
    this.started = false;
  }

  async init() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PCM_SPEC.sampleRate,
    });

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume().catch(() => {});
    }

    this.processor = this.audioContext.createScriptProcessor(1024, 1, 1);
    this.processor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      let written = 0;

      while (written < output.length && this.queue.length > 0) {
        const current = this.queue[0];
        const available = current.length - this.offset;
        const needed = output.length - written;
        const count = Math.min(available, needed);

        for (let i = 0; i < count; i++) {
          output[written + i] = current[this.offset + i] / 32768;
        }

        written += count;
        this.offset += count;

        if (this.offset >= current.length) {
          this.queue.shift();
          this.offset = 0;
        }
      }

      for (let i = written; i < output.length; i++) {
        output[i] = 0;
      }
    };

    this.processor.connect(this.audioContext.destination);
    this.started = true;
  }

  async enqueue(int16Frame) {
    await this.init();
    this.queue.push(new Int16Array(int16Frame));
    return true;
  }

  async close() {
    this.queue = [];
    this.offset = 0;
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.started = false;
  }
}
