import { PCM_SPEC } from './PcmPacket.js';

export class PcmPlaybackEngine {
  constructor() {
    this.audioContext = null;
    this._workletNode = null;
    this._fallbackProcessor = null;
    this._fallbackQueue = [];
    this._fallbackOffset = 0;
    this.started = false;
    this._speakerRouteLogged = false;
    this._processorConnected = false;
  }

  async init() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PCM_SPEC.sampleRate,
    });

    await this.ensureAudioContextResumed('init');

    try {
      await this.audioContext.audioWorklet.addModule('/pcm-playback-worklet.js');
      this._workletNode = new AudioWorkletNode(this.audioContext, 'pcm-playback-processor', {
        outputChannelCount: [1],
      });
      this._workletNode.connect(this.audioContext.destination);
    } catch (err) {
      console.warn('AudioWorklet not supported for playback, falling back to ScriptProcessor:', err.message);
      this._useFallback();
    }

    this._processorConnected = true;
    this.started = true;
  }

  _useFallback() {
    this._fallbackProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
    this._fallbackProcessor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      let written = 0;

      while (written < output.length && this._fallbackQueue.length > 0) {
        const current = this._fallbackQueue[0];
        const available = current.length - this._fallbackOffset;
        const needed = output.length - written;
        const count = Math.min(available, needed);

        for (let i = 0; i < count; i++) {
          let sample = (current[this._fallbackOffset + i] / 32768) * 2.5;
          if (sample > 1.0) sample = 1.0;
          else if (sample < -1.0) sample = -1.0;
          output[written + i] = sample;
        }

        written += count;
        this._fallbackOffset += count;

        if (this._fallbackOffset >= current.length) {
          this._fallbackQueue.shift();
          this._fallbackOffset = 0;
        }
      }

      for (let i = written; i < output.length; i++) {
        output[i] = 0;
      }
    };

    this._fallbackProcessor.connect(this.audioContext.destination);
  }

  async ensureAudioContextResumed(reason = 'unknown') {
    if (!this.audioContext) return false;

    if (this.audioContext.state !== 'suspended') return true;

    try {
      await this.audioContext.resume();
      return this.audioContext.state === 'running';
    } catch (err) {
      console.warn('AUDIO_CONTEXT_RESUME_FAILED', { reason, error: err?.message || String(err) });
      return false;
    }
  }

  async enqueue(int16Frame) {
    if (!this.started) {
      await this.init();
    }
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }

    const samples = (int16Frame instanceof Int16Array) ? int16Frame : new Int16Array(int16Frame);
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'enqueue', samples });
    } else if (this._fallbackProcessor) {
      this._fallbackQueue.push(samples);
    }
    return true;
  }

  async close() {
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'clear' });
      this._workletNode.disconnect();
      this._workletNode = null;
    }
    if (this._fallbackProcessor) {
      this._fallbackProcessor.disconnect();
      this._fallbackProcessor.onaudioprocess = null;
      this._fallbackProcessor = null;
      this._fallbackQueue = [];
      this._fallbackOffset = 0;
    }
    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this.started = false;
    this._processorConnected = false;
  }
}
