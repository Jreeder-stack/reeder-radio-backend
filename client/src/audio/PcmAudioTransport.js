import { PCM_AUDIO, buildPcmPacket, parsePcmPacket, validatePcmPacketMeta } from './pcmAudioConstants.js';

const TX_LOG_PREFIX = '[AUDIO-NEW][TX]';
const RX_LOG_PREFIX = '[AUDIO-NEW][RX]';
const LOG_INTERVAL = 50;

class PcmAudioTransport {
  constructor() {
    this._sequence = 0;
    this._txFrameCount = 0;
    this._rxFrameCount = 0;
    this._rxValidCount = 0;
    this._rxInvalidCount = 0;
    this._onValidPacketHandlers = new Map();
  }

  addOnValidPacket(key, callback) {
    this._onValidPacketHandlers.set(key, callback);
  }

  hasHandler(key) {
    return this._onValidPacketHandlers.has(key);
  }

  removeOnValidPacket(key) {
    this._onValidPacketHandlers.delete(key);
  }

  setOnValidPacket(callback) {
    this._onValidPacketHandlers.clear();
    if (callback) this._onValidPacketHandlers.set('default', callback);
  }

  resetTx() {
    this._sequence = 0;
    this._txFrameCount = 0;
  }

  resetRx() {
    this._rxFrameCount = 0;
    this._rxValidCount = 0;
    this._rxInvalidCount = 0;
  }

  sendFrame(ws, int16Samples, senderUnitId, channelId) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;

    this._sequence = (this._sequence + 1) & 0xFFFF;
    this._txFrameCount++;

    const packet = buildPcmPacket(this._sequence, senderUnitId, channelId, int16Samples);

    if (this._txFrameCount === 1 || this._txFrameCount % LOG_INTERVAL === 0) {
      console.log(`${TX_LOG_PREFIX} codec=${PCM_AUDIO.CODEC} sampleRate=${PCM_AUDIO.SAMPLE_RATE} frameSamples=${PCM_AUDIO.FRAME_SAMPLES} payloadBytes=${int16Samples.byteLength} sequence=${this._sequence} totalFrames=${this._txFrameCount}`);
    }

    ws.send(packet);
    return true;
  }

  receiveData(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer)) return;

    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.length < 1 || bytes[0] !== PCM_AUDIO.FRAME_TYPE) return;

    this._rxFrameCount++;

    const packet = parsePcmPacket(arrayBuffer);
    if (!packet) {
      this._rxInvalidCount++;
      if (this._rxInvalidCount <= 5) {
        console.warn(`${RX_LOG_PREFIX} Failed to parse PCM packet, totalInvalid=${this._rxInvalidCount}`);
      }
      return;
    }

    const validation = validatePcmPacketMeta(packet);
    if (!validation.valid) {
      this._rxInvalidCount++;
      if (this._rxInvalidCount <= 5) {
        console.warn(`${RX_LOG_PREFIX} Invalid metadata: ${validation.errors.join(', ')}`);
      }
      return;
    }

    this._rxValidCount++;

    if (this._rxValidCount === 1 || this._rxValidCount % LOG_INTERVAL === 0) {
      console.log(`${RX_LOG_PREFIX} codec=${packet.codec} payloadBytes=${packet.payloadBytes} sampleCount=${packet.payload.length} sequence=${packet.sequence} totalValid=${this._rxValidCount} handlers=${this._onValidPacketHandlers.size}`);
    }

    for (const handler of this._onValidPacketHandlers.values()) {
      try {
        handler(packet);
      } catch (e) {
        console.error(`${RX_LOG_PREFIX} Handler error:`, e.message);
      }
    }
  }
}

export const pcmAudioTransport = new PcmAudioTransport();
