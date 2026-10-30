import { PCM_SPEC } from './PcmPacket.js';
import { StreamingPcmFrameResampler } from './StreamingPcmFrameResampler.js';
import { getSharedAudioContext } from './iosAudioUnlock.js';

const PRE_BUFFER_MS = 400;
const PRE_BUFFER_FRAMES = Math.ceil(
  (PCM_SPEC.sampleRate * PRE_BUFFER_MS / 1000) / PCM_SPEC.frameSamples
);

const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 1000;

export class PcmCaptureEngine {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this._workletNode = null;
    this._fallbackProcessor = null;
    this._fallbackBuffer = new Int16Array(0);
    this._fallbackConverter = null;
    this.running = false;
    this.onFrame = null;
    this.onTrackEnded = null;
    this._trackEndedError = false;
    this._generation = 0;
    this._warmedUp = false;
    this._warmupPromise = null;
    this._preBuffer = [];
    this.noiseSuppression = false;
  }

  async warmup() {
    if (this._warmedUp) return;
    if (this._warmupPromise) return this._warmupPromise;
    this._warmupPromise = this._doWarmup();
    try {
      await this._warmupPromise;
    } finally {
      this._warmupPromise = null;
    }
  }

  async _doWarmup() {

    const gen = ++this._generation;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: PCM_SPEC.sampleRate,
        echoCancellation: true,
        noiseSuppression: this.noiseSuppression,
        autoGainControl: false,
      },
    });

    if (this._generation !== gen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this.stream = stream;
    this._trackEndedError = false;

    const micTrack = stream.getAudioTracks()[0];
    if (micTrack) {
      micTrack.addEventListener('ended', () => {
        console.error('[PcmCaptureEngine] Mic track ended unexpectedly');
        this._trackEndedError = true;
        if (this.running) {
          this.running = false;
          this.onFrame = null;
          if (this.onTrackEnded) {
            try { this.onTrackEnded(); } catch (e) {
              console.error('[PcmCaptureEngine] onTrackEnded callback error:', e);
            }
          }
        }
      });
    }

    // Reuse the shared AudioContext (created at PCM_SPEC.sampleRate by iosAudioUnlock)
    // so iOS PWA `visibilitychange`/`pageshow` resumes recover capture via resumeSharedAudio()
    // without needing a per-engine resume path. Mic stream lifecycle is still managed here.
    const audioContext = getSharedAudioContext();

    if (this._generation !== gen) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return;
    }

    this.audioContext = audioContext;
    const actualRate = this.audioContext.sampleRate;
    const inputTrackRate = micTrack?.getSettings?.().sampleRate;
    console.log('[PcmCaptureEngine] CAPTURE_RATE', {
      requestedRate: PCM_SPEC.sampleRate,
      audioContextRate: actualRate,
      microphoneTrackRate: inputTrackRate || 'unspecified',
      resampling: actualRate !== PCM_SPEC.sampleRate,
    });

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (this._generation !== gen) {
      this._cleanupPartial();
      return;
    }

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    try {
      await this.audioContext.audioWorklet.addModule('/pcm-capture-worklet.js');

      if (this._generation !== gen) {
        this._cleanupPartial();
        return;
      }

      this._workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');

      this._workletNode.port.onmessage = (event) => {
        if (event.data.type === 'captureConfig') {
          console.log('[PcmCaptureEngine] WORKLET_CAPTURE_CONFIG', event.data);
        } else if (event.data.type === 'pcmFrame') {
          if (this.running && this.onFrame) {
            this.onFrame(event.data.samples);
          } else {
            this._pushPreBuffer(event.data.samples);
          }
        }
      };

      this.source.connect(this._workletNode);
      this._workletNode.connect(this.audioContext.destination);
    } catch (err) {
      console.warn('AudioWorklet not supported, falling back to ScriptProcessor:', err.message);
      if (this._generation !== gen) {
        this._cleanupPartial();
        return;
      }
      this._useFallback();
    }

    if (this._generation !== gen) {
      this._cleanupPartial();
      return;
    }

    this._warmedUp = true;
    this._preBuffer = [];
    console.log('[PcmCaptureEngine] Warmed up – mic and AudioContext ready');
  }

  prewarmAudioContext() {
    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch((err) => {
        console.warn('[PcmCaptureEngine] prewarmAudioContext resume failed:', err.message);
      });
    }
  }

  _pushPreBuffer(samples) {
    this._preBuffer.push(samples);
    if (this._preBuffer.length > PRE_BUFFER_FRAMES) {
      this._preBuffer.shift();
    }
  }

  _cleanupPartial() {
    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode.port.onmessage = null;
      this._workletNode = null;
    }
    if (this._fallbackProcessor) {
      this._fallbackProcessor.disconnect();
      this._fallbackProcessor.onaudioprocess = null;
      this._fallbackProcessor = null;
      this._fallbackBuffer = new Int16Array(0);
      this._fallbackConverter = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    // AudioContext is shared (see iosAudioUnlock.getSharedAudioContext) — do not close it here.
    this.audioContext = null;
    this._warmedUp = false;
    this._preBuffer = [];
  }

  _useFallback() {
    this._fallbackProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
    this._fallbackBuffer = new Int16Array(0);
    this._fallbackConverter = new StreamingPcmFrameResampler(
      this.audioContext.sampleRate, PCM_SPEC.sampleRate, PCM_SPEC.frameSamples
    );
    console.log('[PcmCaptureEngine] Fallback capture rate conversion', {
      sourceRate: this.audioContext.sampleRate,
      targetRate: PCM_SPEC.sampleRate,
    });
    this._fallbackProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      // Never route microphone samples to speaker playback.
      event.outputBuffer.getChannelData(0).fill(0);
      this._fallbackConverter.push(input, (frame) => {
        if (this.running && this.onFrame) {
          this.onFrame(frame);
        } else {
          this._pushPreBuffer(frame);
        }
      });
    };

    this.source.connect(this._fallbackProcessor);
    this._fallbackProcessor.connect(this.audioContext.destination);
  }

  async start(onFrame) {
    if (this.running) return;

    if (!this._warmedUp) {
      await this.warmup();
    }

    if (this._trackEndedError) {
      console.warn('[PcmCaptureEngine] Mic track previously ended, re-acquiring mic');
      this._trackEndedError = false;
      this._cleanupPartial();
      await this.warmup();
    }

    if (this.audioContext) {
      if (this.audioContext.state === 'closed') {
        console.error('[PcmCaptureEngine] Cannot start: AudioContext is closed');
        throw new Error('audio_context_closed');
      }
      if (this.audioContext.state === 'suspended') {
        console.log('[PcmCaptureEngine] AudioContext suspended, attempting resume...');
        try {
          await Promise.race([
            this.audioContext.resume(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('audio_context_resume_timeout')), AUDIO_CONTEXT_RESUME_TIMEOUT_MS)
            ),
          ]);
        } catch (err) {
          console.error('[PcmCaptureEngine] Failed to resume AudioContext:', err.message);
          throw new Error('audio_context_suspended');
        }
        if (this.audioContext.state !== 'running') {
          console.error('[PcmCaptureEngine] AudioContext still not running after resume attempt, state:', this.audioContext.state);
          throw new Error('audio_context_suspended');
        }
      }
    }

    this.onFrame = onFrame;
    this.running = true;

    this._preBuffer = [];
  }

  async stop() {
    this._generation++;
    this.running = false;
    this.onFrame = null;
  }

  async shutdown() {
    this._generation++;
    this.running = false;
    this.onFrame = null;
    this._trackEndedError = false;
    this._warmedUp = false;
    this._warmupPromise = null;
    this._preBuffer = [];

    if (this._workletNode) {
      this._workletNode.disconnect();
      this._workletNode.port.onmessage = null;
      this._workletNode = null;
    }

    if (this._fallbackProcessor) {
      this._fallbackProcessor.disconnect();
      this._fallbackProcessor.onaudioprocess = null;
      this._fallbackProcessor = null;
      this._fallbackBuffer = new Int16Array(0);
      this._fallbackConverter = null;
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    // AudioContext is shared (see iosAudioUnlock.getSharedAudioContext) — do not close it here.
    this.audioContext = null;

    console.log('[PcmCaptureEngine] Shut down – mic released (shared AudioContext kept alive)');
  }
}
