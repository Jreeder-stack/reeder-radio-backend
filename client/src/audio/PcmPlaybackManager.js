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
    this._prePlaybackBuffer = [];
    this._maxPreBuffer = 100;
    this._gestureListenerAttached = false;
    this._resumeInFlight = false;
  }

  async init() {
    if (this._workletReady) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
          sampleRate: PCM_AUDIO.SAMPLE_RATE,
        });

        if (this._audioContext.state === 'suspended') {
          try {
            await this._audioContext.resume();
          } catch (e) {
            console.warn(`${LOG_PREFIX} AudioContext resume deferred (no user gesture yet):`, e.message);
          }
        }

        await this._audioContext.audioWorklet.addModule('/audio/new-pcm-playback-worklet.js');
        this._workletReady = true;
        this._attachGestureListener();
        console.log(`${LOG_PREFIX} Worklet loaded, sampleRate=${this._audioContext.sampleRate}`);
      } catch (err) {
        console.error(`${LOG_PREFIX} init failed, clearing promise for retry:`, err);
        this._initPromise = null;
        throw err;
      }
    })();

    return this._initPromise;
  }

  _attachGestureListener() {
    if (this._gestureListenerAttached) return;
    this._gestureListenerAttached = true;

    const resumeOnGesture = () => {
      if (this._audioContext && this._audioContext.state === 'suspended') {
        this._audioContext.resume().then(() => {
          console.log(`${LOG_PREFIX} AudioContext resumed via user gesture`);
        }).catch(() => {});
      }
    };

    ['touchstart', 'touchend', 'click', 'keydown'].forEach((evt) => {
      document.addEventListener(evt, resumeOnGesture, { once: false, passive: true });
    });
  }

  async ensureAudioContextResumed() {
    if (!this._audioContext) return;
    if (this._audioContext.state !== 'suspended') return;
    if (this._resumeInFlight) return;
    this._resumeInFlight = true;
    try {
      await this._audioContext.resume();
      console.log(`${LOG_PREFIX} AudioContext resumed explicitly (state=${this._audioContext.state})`);
    } catch (e) {
      console.warn(`${LOG_PREFIX} AudioContext resume failed:`, e.message);
    } finally {
      this._resumeInFlight = false;
    }
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

    if (this._prePlaybackBuffer.length > 0) {
      const validFrames = this._prePlaybackBuffer.filter(f => f !== null);
      console.log(`${LOG_PREFIX} Flushing ${validFrames.length} buffered frames`);
      for (const buffered of validFrames) {
        this._workletNode.port.postMessage({
          type: 'pcmFrame',
          samples: buffered,
        }, [buffered.buffer]);
        this._enqueueCount++;
      }
      this._prePlaybackBuffer = [];
    }

    console.log(`${LOG_PREFIX} Playback started`);
  }

  enqueue(int16Samples) {
    if (this._muted) return false;

    if (!this._playing || !this._workletNode) {
      if (this._prePlaybackBuffer.length < this._maxPreBuffer) {
        this._prePlaybackBuffer.push(new Int16Array(int16Samples));
        if (this._prePlaybackBuffer.length === 1) {
          console.log(`${LOG_PREFIX} buffering frames before playback ready`);
        }
      } else if (this._prePlaybackBuffer.length === this._maxPreBuffer) {
        console.warn(`${LOG_PREFIX} pre-playback buffer full (${this._maxPreBuffer} frames), dropping new frames`);
        this._prePlaybackBuffer.push(null);
      }
      return false;
    }

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
    this._prePlaybackBuffer = [];
  }

  stopPlayback() {
    if (!this._playing) return;

    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    this._playing = false;
    this._prePlaybackBuffer = [];
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
