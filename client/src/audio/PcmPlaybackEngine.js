import { PCM_SPEC } from './PcmPacket.js';

export class PcmPlaybackEngine {
  constructor() {
    this.audioContext = null;
    this.processor = null;
    this.queue = [];
    this.offset = 0;
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
    this._processorConnected = true;
    this.started = true;
    console.log('RX_PLAYBACK_STARTED', {
      started: this.started,
      processorConnected: this._processorConnected,
      hasDestination: !!this.audioContext?.destination,
    });
  }

  async ensureAudioContextResumed(reason = 'unknown') {
    if (!this.audioContext) return false;

    console.log('AUDIO_CONTEXT_STATE', {
      reason,
      state: this.audioContext.state,
      sampleRate: this.audioContext.sampleRate,
      baseLatency: this.audioContext.baseLatency ?? null,
      outputLatency: this.audioContext.outputLatency ?? null,
    });

    if (this.audioContext.state !== 'suspended') return true;

    try {
      await this.audioContext.resume();
      console.log('AUDIO_CONTEXT_RESUMED', { reason, state: this.audioContext.state });
      return this.audioContext.state === 'running';
    } catch (err) {
      console.warn('AUDIO_CONTEXT_RESUMED', {
        reason,
        state: this.audioContext.state,
        error: err?.message || String(err),
      });
      return false;
    }
  }

  async enqueue(int16Frame) {
    await this.init();
    await this.ensureAudioContextResumed('enqueue');

    if (!this._speakerRouteLogged) {
      this._speakerRouteLogged = true;
      const sinkIdSupported = typeof this.audioContext?.setSinkId === 'function';
      console.log('SPEAKER_ROUTE_SELECTED', {
        route: 'default',
        sinkIdSupported,
      });
    }

    this.queue.push(new Int16Array(int16Frame));
    console.log('RX_QUEUE_ENQUEUED', {
      frameSamples: int16Frame?.length || 0,
      queueDepth: this.queue.length,
      offset: this.offset,
      processorConnected: this._processorConnected,
      hasDestination: !!this.audioContext?.destination,
    });
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
