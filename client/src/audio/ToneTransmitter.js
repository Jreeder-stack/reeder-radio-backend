import toneEngine from './toneEngine.js';

class ToneTransmitter {
  constructor() {
    this._ws = null;
    this.isTransmitting = false;
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

  async startToneTransmission() {
    console.log('[AUDIO-REBUILD] startToneTransmission() — audio capture intentionally disabled during rebuild');
    this.isTransmitting = false;
    return false;
  }

  async stopToneTransmission() {
    console.log('[AUDIO-REBUILD] stopToneTransmission() — intentionally disabled during rebuild');
    this.isTransmitting = false;
  }

  async transmitTone(type, duration) {
    console.log(`[AUDIO-REBUILD] transmitTone(${type}, ${duration}) — transmission intentionally disabled during rebuild, playing locally only`);
    toneEngine.playEmergencyTone(type, duration);
    return false;
  }

  disconnect() {
    this.isTransmitting = false;
    this._ws = null;
  }
}

export const toneTransmitter = new ToneTransmitter();
export default toneTransmitter;
