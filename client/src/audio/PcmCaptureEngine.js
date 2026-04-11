import { PCM_SPEC } from './PcmPacket.js';

const PRE_BUFFER_MS = 400;
const PRE_BUFFER_FRAMES = Math.ceil(
  (PCM_SPEC.sampleRate * PRE_BUFFER_MS / 1000) / PCM_SPEC.frameSamples
);

export class PcmCaptureEngine {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this._workletNode = null;
    this._fallbackProcessor = null;
    this._fallbackBuffer = new Int16Array(0);
    this.running = false;
    this.onFrame = null;
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
        echoCancellation: false,
        noiseSuppression: this.noiseSuppression,
        autoGainControl: false,
      },
    });

    if (this._generation !== gen) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    this.stream = stream;

    const audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PCM_SPEC.sampleRate,
    });

    if (this._generation !== gen) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      await audioContext.close().catch(() => {});
      return;
    }

    this.audioContext = audioContext;

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
        if (event.data.type === 'pcmFrame') {
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
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
    this._warmedUp = false;
    this._preBuffer = [];
  }

  _useFallback() {
    this._fallbackProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
    this._fallbackBuffer = new Int16Array(0);

    this._fallbackProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const pcmChunk = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcmChunk[i] = s < 0 ? s * 32768 : s * 32767;
      }

      const merged = new Int16Array(this._fallbackBuffer.length + pcmChunk.length);
      merged.set(this._fallbackBuffer, 0);
      merged.set(pcmChunk, this._fallbackBuffer.length);
      this._fallbackBuffer = merged;

      while (this._fallbackBuffer.length >= PCM_SPEC.frameSamples) {
        const frame = this._fallbackBuffer.slice(0, PCM_SPEC.frameSamples);
        this._fallbackBuffer = this._fallbackBuffer.slice(PCM_SPEC.frameSamples);

        if (this.running && this.onFrame) {
          this.onFrame(frame);
        } else {
          this._pushPreBuffer(frame);
        }
      }
    };

    this.source.connect(this._fallbackProcessor);
    this._fallbackProcessor.connect(this.audioContext.destination);
  }

  async start(onFrame) {
    if (this.running) return;

    if (!this._warmedUp) {
      await this.warmup();
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
    }

    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }

    if (this.audioContext) {
      await this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }

    console.log('[PcmCaptureEngine] Shut down – mic and AudioContext released');
  }
}
