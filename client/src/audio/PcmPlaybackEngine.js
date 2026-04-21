import { PCM_SPEC } from './PcmPacket.js';
import { processRadioVoice, cleanup as cleanupDSP, updateSettings as updateDSPSettings } from './radioVoiceDSP.js';
import { getSharedAudioContext } from './iosAudioUnlock.js';

const DEFAULT_CHANNEL_KEY = '__default__';

export class PcmPlaybackEngine {
  constructor() {
    this.audioContext = null;
    this._busNode = null;
    this._dspOutput = null;
    this._dspSettings = null;
    this._channels = new Map();
    this._channelGains = new Map();
    this._workletAvailable = true;
    this.started = false;
    this._initPromise = null;
    this._pendingFrames = [];
    this._framesEnqueuedDuringInit = 0;
  }

  init() {
    if (this.started) return Promise.resolve();
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit().finally(() => {
      this._initPromise = null;
    });
    return this._initPromise;
  }

  async _doInit() {
    this.audioContext = getSharedAudioContext();
    if (this.audioContext.sampleRate !== PCM_SPEC.sampleRate) {
      console.warn('[PcmPlaybackEngine] Shared AudioContext sampleRate mismatch', {
        expected: PCM_SPEC.sampleRate,
        actual: this.audioContext.sampleRate,
      });
    }

    await this.ensureAudioContextResumed('init');

    this._busNode = this.audioContext.createGain();
    this._busNode.gain.value = 1.0;

    try {
      await this.audioContext.audioWorklet.addModule('/pcm-playback-worklet.js');
      this._workletAvailable = true;
    } catch (err) {
      console.warn('AudioWorklet not supported for playback, falling back to ScriptProcessor:', err.message);
      this._workletAvailable = false;
    }

    this._dspOutput = processRadioVoice(this.audioContext, this._busNode, this._dspSettings);
    this._dspOutput.connect(this.audioContext.destination);

    this.started = true;

    if (this._pendingFrames.length > 0) {
      console.log('[PcmPlaybackEngine] Flushing pending frames captured during init', {
        flushed: this._pendingFrames.length,
        framesEnqueuedDuringInit: this._framesEnqueuedDuringInit,
      });
      const pending = this._pendingFrames;
      this._pendingFrames = [];
      for (const item of pending) {
        this._deliverFrame(item.samples, item.channelKey);
      }
    }
    this._framesEnqueuedDuringInit = 0;
  }

  _ensureChannel(channelKey) {
    let ch = this._channels.get(channelKey);
    if (ch) return ch;

    const gainNode = this.audioContext.createGain();
    const persisted = this._channelGains.get(channelKey);
    gainNode.gain.value = (typeof persisted === 'number') ? persisted : 1.0;
    gainNode.connect(this._busNode);

    if (this._workletAvailable) {
      let workletNode;
      try {
        workletNode = new AudioWorkletNode(this.audioContext, 'pcm-playback-processor', {
          outputChannelCount: [1],
        });
      } catch (err) {
        console.warn('[PcmPlaybackEngine] Failed to create AudioWorkletNode, falling back:', err?.message);
        this._workletAvailable = false;
      }
      if (workletNode) {
        workletNode.port.onmessage = (event) => {
          if (event.data.type === 'underrun') {
            console.warn('AUDIO_PLAYBACK_UNDERRUN', {
              channelKey,
              count: event.data.count,
              bufferDepth: event.data.bufferDepth,
            });
          } else if (event.data.type === 'diagnostics') {
            console.log('AUDIO_PLAYBACK_DIAG', {
              channelKey,
              framesReceived: event.data.framesReceived,
              framesPlayed: event.data.framesPlayed,
              underrunCount: event.data.underrunCount,
              bufferDepth: event.data.bufferDepth,
              avgBufferDepth: event.data.avgBufferDepth,
              smoothedDepth: event.data.smoothedDepth,
            });
          } else if (event.data.type === 'drain_complete') {
            console.log('AUDIO_PLAYBACK_DRAIN_COMPLETE', { channelKey });
          }
        };
        workletNode.connect(gainNode);
        ch = { type: 'worklet', node: workletNode, gainNode, channelKey };
        this._channels.set(channelKey, ch);
        return ch;
      }
    }

    const fallbackProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
    const state = {
      type: 'fallback',
      node: fallbackProcessor,
      gainNode,
      channelKey,
      queue: [],
      offset: 0,
    };
    fallbackProcessor.onaudioprocess = (event) => {
      const output = event.outputBuffer.getChannelData(0);
      let written = 0;
      while (written < output.length && state.queue.length > 0) {
        const current = state.queue[0];
        const available = current.length - state.offset;
        const needed = output.length - written;
        const count = Math.min(available, needed);
        for (let i = 0; i < count; i++) {
          output[written + i] = current[state.offset + i] / 32768;
        }
        written += count;
        state.offset += count;
        if (state.offset >= current.length) {
          state.queue.shift();
          state.offset = 0;
        }
      }
      for (let i = written; i < output.length; i++) {
        output[i] = 0;
      }
    };
    fallbackProcessor.connect(gainNode);
    this._channels.set(channelKey, state);
    return state;
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

  _deliverFrame(samples, channelKey) {
    const ch = this._ensureChannel(channelKey);
    if (ch.type === 'worklet') {
      ch.node.port.postMessage({ type: 'enqueue', samples });
    } else {
      ch.queue.push(samples);
    }
  }

  async enqueue(int16Frame, channelKey = DEFAULT_CHANNEL_KEY) {
    const samples = (int16Frame instanceof Int16Array) ? int16Frame : new Int16Array(int16Frame);
    const key = channelKey || DEFAULT_CHANNEL_KEY;

    if (!this.started) {
      this._pendingFrames.push({ samples, channelKey: key });
      this._framesEnqueuedDuringInit++;
      this.init().catch((err) => {
        console.warn('[PcmPlaybackEngine] init() failed during enqueue:', err?.message);
      });
      return true;
    }

    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(() => {});
    }

    this._deliverFrame(samples, key);
    return true;
  }

  setChannelGain(channelKey, gain) {
    const key = channelKey || DEFAULT_CHANNEL_KEY;
    const clamped = Math.max(0, Math.min(1.5, Number(gain) || 0));
    this._channelGains.set(key, clamped);
    const ch = this._channels.get(key);
    if (ch && ch.gainNode) {
      try {
        ch.gainNode.gain.value = clamped;
      } catch (_) {}
    }
  }

  getChannelGain(channelKey) {
    const key = channelKey || DEFAULT_CHANNEL_KEY;
    if (this._channelGains.has(key)) return this._channelGains.get(key);
    return 1.0;
  }

  removeChannel(channelKey) {
    const key = channelKey || DEFAULT_CHANNEL_KEY;
    const ch = this._channels.get(key);
    if (!ch) return;
    try {
      if (ch.type === 'worklet') {
        ch.node.port.postMessage({ type: 'clear' });
        ch.node.disconnect();
      } else {
        ch.node.disconnect();
        ch.node.onaudioprocess = null;
      }
    } catch (_) {}
    try { ch.gainNode.disconnect(); } catch (_) {}
    this._channels.delete(key);
  }

  // Returns true if the worklet exists for this channel (used by the
  // transport manager to forward setTargetDepth messages).
  get _workletNode() {
    for (const ch of this._channels.values()) {
      if (ch.type === 'worklet') return ch.node;
    }
    return null;
  }

  postToAllWorklets(msg) {
    for (const ch of this._channels.values()) {
      if (ch.type === 'worklet') {
        try { ch.node.port.postMessage(msg); } catch (_) {}
      }
    }
  }

  drain() {
    this.postToAllWorklets({ type: 'drain' });
  }

  updateDspSettings(settings) {
    this._dspSettings = settings;
    updateDSPSettings(settings);
  }

  async close() {
    cleanupDSP();
    if (this._dspOutput) {
      try { this._dspOutput.disconnect(); } catch (_) {}
      this._dspOutput = null;
    }
    for (const ch of this._channels.values()) {
      try {
        if (ch.type === 'worklet') {
          ch.node.port.postMessage({ type: 'clear' });
          ch.node.disconnect();
        } else {
          ch.node.disconnect();
          ch.node.onaudioprocess = null;
        }
      } catch (_) {}
      try { ch.gainNode.disconnect(); } catch (_) {}
    }
    this._channels.clear();
    if (this._busNode) {
      try { this._busNode.disconnect(); } catch (_) {}
      this._busNode = null;
    }
    // AudioContext is shared (see iosAudioUnlock.getSharedAudioContext) — do not close it here.
    this.audioContext = null;
    this.started = false;
    this._initPromise = null;
    this._pendingFrames = [];
    this._framesEnqueuedDuringInit = 0;
  }
}
