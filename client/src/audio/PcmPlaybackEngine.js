import { PCM_SPEC } from './PcmPacket.js';
import { processRadioVoice, cleanup as cleanupDSP } from './radioVoiceDSP.js';

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
    this._dspOutput = null;
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
      this._workletNode.port.onmessage = (event) => {
        if (event.data.type === 'underrun') {
          console.warn('AUDIO_PLAYBACK_UNDERRUN', {
            count: event.data.count,
            bufferDepth: event.data.bufferDepth,
          });
        } else if (event.data.type === 'diagnostics') {
          console.log('AUDIO_PLAYBACK_DIAG', {
            framesReceived: event.data.framesReceived,
            framesPlayed: event.data.framesPlayed,
            underrunCount: event.data.underrunCount,
            bufferDepth: event.data.bufferDepth,
            avgBufferDepth: event.data.avgBufferDepth,
            smoothedDepth: event.data.smoothedDepth,
          });
        } else if (event.data.type === 'drain_complete') {
          console.log('AUDIO_PLAYBACK_DRAIN_COMPLETE');
        }
      };
      this._dspOutput = processRadioVoice(this.audioContext, this._workletNode);
      this._dspOutput.connect(this.audioContext.destination);

      this._workletNode.port.postMessage({ type: 'setGain', gain: 1.5 });
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
          let sample = (current[this._fallbackOffset + i] / 32768) * 3.0;
          const abs = Math.abs(sample);
          if (abs >= 0.9) {
            const over = abs - 0.9;
            const compressed = 0.9 + over / (1.0 + over * 10.0);
            sample = sample < 0 ? -compressed : compressed;
          }
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

  drain() {
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'drain' });
    }
  }

  async close() {
    cleanupDSP();
    if (this._dspOutput) {
      try { this._dspOutput.disconnect(); } catch (_) {}
      this._dspOutput = null;
    }
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
