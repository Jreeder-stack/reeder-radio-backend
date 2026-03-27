import { PCM_SPEC } from './PcmPacket.js';

export class PcmCaptureEngine {
  constructor() {
    this.audioContext = null;
    this.stream = null;
    this.source = null;
    this.processor = null;
    this.buffer = new Int16Array(0);
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
    this.processor = this.audioContext.createScriptProcessor(1024, 1, 1);

    this.processor.onaudioprocess = (event) => {
      if (!this.running) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcmChunk = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcmChunk[i] = s < 0 ? s * 32768 : s * 32767;
      }

      const merged = new Int16Array(this.buffer.length + pcmChunk.length);
      merged.set(this.buffer, 0);
      merged.set(pcmChunk, this.buffer.length);
      this.buffer = merged;

      while (this.buffer.length >= PCM_SPEC.frameSamples) {
        const frame = this.buffer.slice(0, PCM_SPEC.frameSamples);
        this.buffer = this.buffer.slice(PCM_SPEC.frameSamples);
        console.log('TX_FRAME_READY', { samples: frame.length });
        if (this.onFrame) this.onFrame(frame);
      }
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);

    this.running = true;
    console.log('TX_CAPTURE_STARTED');
  }

  async stop() {
    this.running = false;
    this.buffer = new Int16Array(0);

    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
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
