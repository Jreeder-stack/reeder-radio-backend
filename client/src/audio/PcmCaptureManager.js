import { PCM_AUDIO } from './pcmAudioConstants.js';

const LOG_PREFIX = '[AUDIO-NEW][TX-CAPTURE]';
const RMS_LOG_INTERVAL = 50;

class PcmCaptureManager {
  constructor() {
    this._audioContext = null;
    this._stream = null;
    this._sourceNode = null;
    this._workletNode = null;
    this._workletReady = false;
    this._capturing = false;
    this._onFrame = null;
    this._frameCount = 0;
  }

  setOnFrame(callback) {
    this._onFrame = callback;
  }

  async init() {
    if (this._workletReady) return;

    this._audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PCM_AUDIO.SAMPLE_RATE,
    });

    if (this._audioContext.state === 'suspended') {
      await this._audioContext.resume();
    }

    await this._audioContext.audioWorklet.addModule('/audio/new-pcm-capture-worklet.js');
    this._workletReady = true;
    console.log(`${LOG_PREFIX} Worklet loaded, sampleRate=${this._audioContext.sampleRate}`);
  }

  async startCapture() {
    if (this._capturing) {
      console.log(`${LOG_PREFIX} Already capturing`);
      return;
    }

    await this.init();

    this._stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: PCM_AUDIO.SAMPLE_RATE,
        channelCount: PCM_AUDIO.CHANNELS,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);

    this._workletNode = new AudioWorkletNode(this._audioContext, 'new-pcm-capture-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: PCM_AUDIO.CHANNELS,
    });

    this._frameCount = 0;

    this._workletNode.port.onmessage = (e) => {
      if (e.data.type === 'pcmFrame') {
        this._frameCount++;
        const { samples, rms, frameIndex } = e.data;

        if (this._frameCount === 1 || this._frameCount % RMS_LOG_INTERVAL === 0) {
          console.log(`${LOG_PREFIX} frame=${this._frameCount} rms=${rms.toFixed(4)} samples=${samples.length}`);
        }

        if (this._onFrame) {
          this._onFrame(samples);
        }
      }
    };

    this._sourceNode.connect(this._workletNode);
    this._workletNode.port.postMessage({ type: 'start' });
    this._capturing = true;

    console.log(`${LOG_PREFIX} Capture started: ${PCM_AUDIO.SAMPLE_RATE}Hz mono Int16 ${PCM_AUDIO.FRAME_SAMPLES}-sample frames`);
  }

  stopCapture() {
    if (!this._capturing) return;

    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'stop' });
      this._workletNode.disconnect();
      this._workletNode = null;
    }

    if (this._sourceNode) {
      this._sourceNode.disconnect();
      this._sourceNode = null;
    }

    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }

    this._capturing = false;
    console.log(`${LOG_PREFIX} Capture stopped after ${this._frameCount} frames`);
  }

  isCapturing() {
    return this._capturing;
  }

  destroy() {
    this.stopCapture();
    if (this._audioContext) {
      this._audioContext.close().catch(() => {});
      this._audioContext = null;
      this._workletReady = false;
    }
  }
}

export const pcmCaptureManager = new PcmCaptureManager();
