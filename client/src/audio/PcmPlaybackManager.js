import { PCM_AUDIO } from './pcmAudioConstants.js';

const LOG_PREFIX = '[AUDIO-NEW][RX-PLAYBACK]';
const STATS_LOG_INTERVAL = 50;

class PcmPlaybackManager {
  constructor() {
    this._audioContext = null;
    this._workletNode = null;
    this._workletReady = false;
    this._initPromise = null;
    this._playing = false;
    this._enqueueCount = 0;
    this._muted = false;
  }

  async init() {
    if (this._workletReady) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: PCM_AUDIO.SAMPLE_RATE,
      });

      if (this._audioContext.state === 'suspended') {
        await this._audioContext.resume();
      }

      await this._audioContext.audioWorklet.addModule('/audio/new-pcm-playback-worklet.js');
      this._workletReady = true;
      console.log(`${LOG_PREFIX} Worklet loaded, sampleRate=${this._audioContext.sampleRate}`);
    })();

    return this._initPromise;
  }

  async startPlayback() {
    if (this._playing) return;

    await this.init();

    this._workletNode = new AudioWorkletNode(this._audioContext, 'new-pcm-playback-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      channelCount: PCM_AUDIO.CHANNELS,
    });

    this._workletNode.port.onmessage = (e) => {
      if (e.data.type === 'stats') {
        console.log(`${LOG_PREFIX} stats: queueDepth=${e.data.queueDepth} enqueued=${e.data.totalEnqueued} played=${e.data.totalPlayed} underruns=${e.data.underruns}`);
      }
    };

    this._workletNode.connect(this._audioContext.destination);
    this._playing = true;
    this._enqueueCount = 0;

    console.log(`${LOG_PREFIX} Playback started`);
  }

  enqueue(int16Samples) {
    if (!this._playing || !this._workletNode || this._muted) return false;

    const copy = new Int16Array(int16Samples);
    this._workletNode.port.postMessage({
      type: 'pcmFrame',
      samples: copy,
    }, [copy.buffer]);

    this._enqueueCount++;

    if (this._enqueueCount === 1 || this._enqueueCount % STATS_LOG_INTERVAL === 0) {
      console.log(`${LOG_PREFIX} enqueued frame #${this._enqueueCount} sampleCount=${int16Samples.length}`);
    }

    return true;
  }

  setMuted(muted) {
    this._muted = muted;
    if (muted && this._workletNode) {
      this._workletNode.port.postMessage({ type: 'reset' });
    }
    console.log(`${LOG_PREFIX} muted=${muted}`);
  }

  reset() {
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'reset' });
    }
    this._enqueueCount = 0;
  }

  stopPlayback() {
    if (!this._playing) return;

    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    this._playing = false;
    console.log(`${LOG_PREFIX} Playback stopped after ${this._enqueueCount} frames`);
  }

  isPlaying() {
    return this._playing;
  }

  destroy() {
    this.stopPlayback();
    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
      this._workletReady = false;
    }
  }
}

export const pcmPlaybackManager = new PcmPlaybackManager();
