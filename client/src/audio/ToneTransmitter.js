import toneEngine from './toneEngine.js';
import { OpusBrowserEncoder } from './OpusBrowserEncoder.js';
import { buildBinaryFrameOpus } from './PcmPacket.js';

const SAMPLE_RATE = 16000;
const FRAME_SIZE = 320;
const CAPTURE_BUFFER_SIZE = 4096;

const TX_STATE = {
  IDLE: 'idle',
  CONTINUOUS: 'continuous',
  FINITE: 'finite',
  DRAINING: 'draining',
};

class ToneTransmitter {
  constructor() {
    this._ws = null;
    this._channelId = null;
    this._unitId = null;
    this.isTransmitting = false;
    this._txState = TX_STATE.IDLE;
    this._encoder = null;
    this._captureCtx = null;
    this._captureDestination = null;
    this._captureSource = null;
    this._captureProcessor = null;
    this._pcmBuffer = new Int16Array(0);
    this._txSequence = 0;
  }

  setWsTransport(ws, channelId, unitId) {
    this._ws = ws;
    if (channelId !== undefined) this._channelId = channelId || '';
    if (unitId !== undefined) this._unitId = unitId || '';
  }

  setRoom(room) {
    if (room && room.ws) {
      this._ws = room.ws;
      this._channelId = room.channelName || '';
      this._unitId = room.unitId || '';
    } else if (room && typeof room === 'object' && room instanceof WebSocket) {
      this._ws = room;
    }
  }

  async _ensureEncoder() {
    if (!this._encoder) {
      this._encoder = new OpusBrowserEncoder();
    }
    if (!this._encoder.isReady()) {
      const ok = await this._encoder.init();
      if (!ok) return false;
    }
    return true;
  }

  _isSendingAllowed() {
    return this._txState === TX_STATE.CONTINUOUS ||
           this._txState === TX_STATE.FINITE ||
           this._txState === TX_STATE.DRAINING;
  }

  _setupCapturePipeline() {
    this._captureCtx = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: SAMPLE_RATE,
    });

    this._captureDestination = this._captureCtx.createMediaStreamDestination();

    this._captureSource = this._captureCtx.createMediaStreamSource(
      this._captureDestination.stream
    );

    this._pcmBuffer = new Int16Array(0);

    this._captureProcessor = this._captureCtx.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);
    this._captureProcessor.onaudioprocess = (event) => {
      if (!this._isSendingAllowed()) return;

      const input = event.inputBuffer.getChannelData(0);
      const pcmChunk = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcmChunk[i] = s < 0 ? s * 32768 : s * 32767;
      }

      const merged = new Int16Array(this._pcmBuffer.length + pcmChunk.length);
      merged.set(this._pcmBuffer, 0);
      merged.set(pcmChunk, this._pcmBuffer.length);
      this._pcmBuffer = merged;

      while (this._pcmBuffer.length >= FRAME_SIZE) {
        const frame = this._pcmBuffer.slice(0, FRAME_SIZE);
        this._pcmBuffer = this._pcmBuffer.slice(FRAME_SIZE);
        if (this._encoder && this._encoder.isReady()) {
          this._encoder.encode(frame);
        }
      }
    };

    this._captureSource.connect(this._captureProcessor);
    this._captureProcessor.connect(this._captureCtx.destination);

    toneEngine.setTxMode(this._captureCtx, this._captureDestination);
  }

  _teardownCapturePipeline() {
    toneEngine.clearTxMode();

    if (this._captureProcessor) {
      this._captureProcessor.onaudioprocess = null;
      this._captureProcessor.disconnect();
      this._captureProcessor = null;
    }
    if (this._captureSource) {
      this._captureSource.disconnect();
      this._captureSource = null;
    }
    if (this._captureDestination) {
      this._captureDestination = null;
    }
    if (this._captureCtx) {
      this._captureCtx.close().catch(() => {});
      this._captureCtx = null;
    }
    this._pcmBuffer = new Int16Array(0);
  }

  _wireEncoderOutput() {
    this._encoder.setOnEncoded((encoded) => {
      if (!this._isSendingAllowed()) return;
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        console.warn('[ToneTransmitter] WebSocket closed during tone TX');
        return;
      }
      const binFrame = buildBinaryFrameOpus(
        this._txSequence++,
        this._channelId,
        this._unitId,
        encoded
      );
      this._ws.send(binFrame);
    });
  }

  async startToneTransmission() {
    if (this._txState !== TX_STATE.IDLE) {
      return this._txState === TX_STATE.CONTINUOUS;
    }

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.error('[ToneTransmitter] No open WebSocket for tone transmission');
      return false;
    }

    if (!OpusBrowserEncoder.isSupported()) {
      console.error('[ToneTransmitter] WebCodecs AudioEncoder not available');
      return false;
    }

    const encoderOk = await this._ensureEncoder();
    if (!encoderOk) {
      console.error('[ToneTransmitter] Failed to initialize Opus encoder');
      return false;
    }

    this._wireEncoderOutput();

    try {
      this._setupCapturePipeline();
    } catch (err) {
      console.error('[ToneTransmitter] Capture pipeline setup failed:', err);
      this._teardownCapturePipeline();
      if (this._encoder) this._encoder.setOnEncoded(null);
      return false;
    }

    this._txState = TX_STATE.CONTINUOUS;
    this.isTransmitting = true;
    console.log('[ToneTransmitter] Tone transmission started (continuous)');
    return true;
  }

  async stopToneTransmission() {
    if (this._txState !== TX_STATE.CONTINUOUS) return;

    this._txState = TX_STATE.DRAINING;

    if (this._encoder && this._encoder.isReady()) {
      await this._encoder.flush();
    }

    this._txState = TX_STATE.IDLE;
    this.isTransmitting = false;

    this._teardownCapturePipeline();

    if (this._encoder) {
      this._encoder.setOnEncoded(null);
    }

    console.log('[ToneTransmitter] Tone transmission stopped');
  }

  async transmitTone(type, duration) {
    if (this._txState !== TX_STATE.IDLE) {
      console.warn('[ToneTransmitter] Already transmitting, playing tone locally only');
      toneEngine.playEmergencyTone(type, duration);
      return false;
    }

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      console.warn('[ToneTransmitter] No open WebSocket, playing tone locally only');
      toneEngine.playEmergencyTone(type, duration);
      return false;
    }

    if (!OpusBrowserEncoder.isSupported()) {
      console.warn('[ToneTransmitter] WebCodecs not available, playing tone locally only');
      toneEngine.playEmergencyTone(type, duration);
      return false;
    }

    const encoderOk = await this._ensureEncoder();
    if (!encoderOk) {
      console.warn('[ToneTransmitter] Encoder init failed, playing tone locally only');
      toneEngine.playEmergencyTone(type, duration);
      return false;
    }

    this._wireEncoderOutput();

    try {
      this._setupCapturePipeline();
    } catch (err) {
      console.error('[ToneTransmitter] Capture pipeline setup failed:', err);
      this._teardownCapturePipeline();
      if (this._encoder) this._encoder.setOnEncoded(null);
      toneEngine.playEmergencyTone(type, duration);
      return false;
    }

    this._txState = TX_STATE.FINITE;
    this.isTransmitting = true;

    try {
      toneEngine.playEmergencyTone(type, duration);

      const paddedDuration = duration + 200;
      await new Promise((resolve) => setTimeout(resolve, paddedDuration));

      this._txState = TX_STATE.DRAINING;

      if (this._encoder && this._encoder.isReady()) {
        await this._encoder.flush();
      }
    } finally {
      this._txState = TX_STATE.IDLE;
      this.isTransmitting = false;

      this._teardownCapturePipeline();

      if (this._encoder) {
        this._encoder.setOnEncoded(null);
      }
    }

    console.log(`[ToneTransmitter] transmitTone(${type}, ${duration}) complete`);
    return true;
  }

  disconnect() {
    const wasTx = this._txState !== TX_STATE.IDLE;
    this._txState = TX_STATE.IDLE;
    this.isTransmitting = false;

    if (wasTx) {
      this._teardownCapturePipeline();
    }
    if (this._encoder) {
      this._encoder.destroy();
      this._encoder = null;
    }
    this._ws = null;
    this._channelId = null;
    this._unitId = null;
    this._txSequence = 0;
  }
}

export const toneTransmitter = new ToneTransmitter();
export default toneTransmitter;
