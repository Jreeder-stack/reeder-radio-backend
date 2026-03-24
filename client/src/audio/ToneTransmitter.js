import toneEngine from './toneEngine.js';

const PCM_FRAME_SIZE = 960;

class ToneTransmitter {
  constructor() {
    this.audioContext = null;
    this.mediaStreamDestination = null;
    this._ws = null;
    this._captureWorkletNode = null;
    this._captureWorkletReady = false;
    this._sourceNode = null;
    this._txSequence = 0;
    this.isTransmitting = false;
  }

  _ensureAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }
    return this.audioContext;
  }

  _createFreshMediaStreamDestination() {
    const ctx = this._ensureAudioContext();
    this.mediaStreamDestination = ctx.createMediaStreamDestination();
    return this.mediaStreamDestination;
  }

  setWsTransport(ws) {
    this._ws = ws;
  }

  setRoom(room) {
    if (room && room.ws) {
      this.setWsTransport(room.ws);
    } else if (room && typeof room === 'object' && room instanceof WebSocket) {
      this.setWsTransport(room);
    }
  }

  async _ensureCaptureWorklet() {
    if (this._captureWorkletReady) return;
    const ctx = this._ensureAudioContext();
    await ctx.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
    this._captureWorkletReady = true;
  }

  async startToneTransmission() {
    if (this.isTransmitting) {
      console.log('[ToneTransmitter] Already transmitting');
      return true;
    }

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.error('[ToneTransmitter] No WS transport available');
      return false;
    }

    try {
      const ctx = this._ensureAudioContext();
      await this._ensureCaptureWorklet();
      const destination = this._createFreshMediaStreamDestination();

      toneEngine.setTxMode(ctx, destination);

      const track = destination.stream.getAudioTracks()[0];
      if (!track) {
        console.error('[ToneTransmitter] No audio track from MediaStreamDestination');
        return false;
      }

      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      this._sourceNode = source;

      const captureNode = new AudioWorkletNode(ctx, 'pcm-capture-processor');
      this._captureWorkletNode = captureNode;
      this._txSequence = 0;

      captureNode.port.onmessage = (e) => {
        if (e.data.type === 'pcm') {
          this._sendPcmFrame(e.data.samples);
        }
      };

      source.connect(captureNode);
      captureNode.connect(ctx.destination);
      captureNode.port.postMessage({ type: 'start' });

      this.isTransmitting = true;
      console.log('[ToneTransmitter] Tone capture started via WS');
      return true;

    } catch (err) {
      console.error('[ToneTransmitter] Failed to start tone transmission:', err);
      toneEngine.clearTxMode();
      this._cleanupCapture();
      return false;
    }
  }

  _sendPcmFrame(int16Samples) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const header = new ArrayBuffer(3);
    const view = new DataView(header);
    view.setUint8(0, 0x01);
    view.setUint16(1, this._txSequence & 0xFFFF);
    this._txSequence++;

    const pcmBytes = new Uint8Array(int16Samples.buffer, int16Samples.byteOffset, int16Samples.byteLength);
    const frame = new Uint8Array(3 + pcmBytes.length);
    frame.set(new Uint8Array(header), 0);
    frame.set(pcmBytes, 3);

    try {
      this._ws.send(frame.buffer);
    } catch (err) {
      console.warn('[ToneTransmitter] WS send error:', err.message);
    }
  }

  _cleanupCapture() {
    if (this._captureWorkletNode) {
      try {
        this._captureWorkletNode.port.postMessage({ type: 'stop' });
        this._captureWorkletNode.disconnect();
      } catch (e) {}
      this._captureWorkletNode = null;
    }

    if (this._sourceNode) {
      try { this._sourceNode.disconnect(); } catch (e) {}
      this._sourceNode = null;
    }

    if (this.mediaStreamDestination) {
      try {
        this.mediaStreamDestination.stream.getTracks().forEach(t => t.stop());
      } catch (e) {}
      this.mediaStreamDestination = null;
    }
  }

  async stopToneTransmission() {
    if (!this.isTransmitting) {
      return;
    }

    console.log('[ToneTransmitter] Stopping tone transmission...');

    try {
      toneEngine.clearTxMode();
      this._cleanupCapture();
    } catch (err) {
      console.error('[ToneTransmitter] Stop error:', err);
    } finally {
      this.isTransmitting = false;
      console.log('[ToneTransmitter] Tone transmission stopped');
    }
  }

  async transmitTone(type, duration) {
    console.log(`[ToneTransmitter] Transmitting tone ${type} for ${duration}ms`);

    const started = await this.startToneTransmission();
    if (!started) {
      console.error('[ToneTransmitter] Failed to start transmission for tone');
      toneEngine.playEmergencyTone(type, duration);
      return false;
    }

    toneEngine.playEmergencyTone(type, duration);

    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!toneEngine.isTonePlaying(type)) {
          clearInterval(checkInterval);
          setTimeout(async () => {
            await this.stopToneTransmission();
            resolve(true);
          }, 100);
        }
      }, 50);

      setTimeout(() => {
        clearInterval(checkInterval);
        this.stopToneTransmission().then(() => resolve(true));
      }, duration + 500);
    });
  }

  disconnect() {
    this.stopToneTransmission();
    this._ws = null;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
      this._captureWorkletReady = false;
    }
  }
}

export const toneTransmitter = new ToneTransmitter();
export default toneTransmitter;
