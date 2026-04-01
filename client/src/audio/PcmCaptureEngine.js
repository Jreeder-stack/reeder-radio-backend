import { PCM_SPEC } from './PcmPacket.js';

export class PcmCaptureEngine {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this._workletNode = null;
    this.running = false;
    this.onFrame = null;
  }

  async start(onFrame) {
    if (this.running) return;
    this.onFrame = onFrame;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: PCM_SPEC.sampleRate,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: PCM_SPEC.sampleRate,
    });

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    this.source = this.audioContext.createMediaStreamSource(this.stream);

    try {
      await this.audioContext.audioWorklet.addModule('/pcm-capture-worklet.js');
      this._workletNode = new AudioWorkletNode(this.audioContext, 'pcm-capture-processor');

      this._workletNode.port.onmessage = (event) => {
        if (!this.running) return;
        if (event.data.type === 'pcmFrame' && this.onFrame) {
          this.onFrame(event.data.samples);
        }
      };

      this.source.connect(this._workletNode);
      this._workletNode.connect(this.audioContext.destination);
    } catch (err) {
      console.warn('AudioWorklet not supported, falling back to ScriptProcessor:', err.message);
      this._useFallback();
    }

    this.running = true;
  }

  _useFallback() {
    this._fallbackProcessor = this.audioContext.createScriptProcessor(1024, 1, 1);
    this._fallbackBuffer = new Int16Array(0);

    this._fallbackProcessor.onaudioprocess = (event) => {
      if (!this.running) return;
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
        if (this.onFrame) this.onFrame(frame);
      }
    };

    this.source.connect(this._fallbackProcessor);
    this._fallbackProcessor.connect(this.audioContext.destination);
  }

  async stop() {
    this.running = false;

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
  }
}
