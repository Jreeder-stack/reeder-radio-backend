import { Track } from 'livekit-client';
import toneEngine from './toneEngine.js';

class ToneTransmitter {
  constructor() {
    this.audioContext = null;
    this.mediaStreamDestination = null;
    this.localTrack = null;
    this.browserTrack = null;
    this.room = null;
    this.isTransmitting = false;
  }

  _ensureAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
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

  setRoom(room) {
    this.room = room;
  }

  async startToneTransmission() {
    if (this.isTransmitting) {
      console.log('[ToneTransmitter] Already transmitting');
      return true;
    }

    if (!this.room) {
      console.error('[ToneTransmitter] No room set');
      return false;
    }

    try {
      const ctx = this._ensureAudioContext();
      const destination = this._createFreshMediaStreamDestination();

      toneEngine.setTxMode(ctx, destination);

      this.browserTrack = destination.stream.getAudioTracks()[0];
      
      if (!this.browserTrack) {
        console.error('[ToneTransmitter] No audio track from MediaStreamDestination');
        return false;
      }

      console.log('[ToneTransmitter] Publishing tone track to LiveKit...');
      
      const publication = await this.room.localParticipant.publishTrack(
        this.browserTrack,
        {
          name: 'dispatch-tone',
          source: Track.Source.Microphone
        }
      );
      
      this.localTrack = publication.track;
      this.isTransmitting = true;
      
      console.log('[ToneTransmitter] Tone track published successfully');
      return true;

    } catch (err) {
      console.error('[ToneTransmitter] Failed to start tone transmission:', err);
      toneEngine.clearTxMode();
      this._cleanupDestination();
      return false;
    }
  }

  _cleanupDestination() {
    if (this.browserTrack) {
      try {
        this.browserTrack.stop();
      } catch (e) {}
      this.browserTrack = null;
    }
    this.mediaStreamDestination = null;
  }

  async stopToneTransmission() {
    if (!this.isTransmitting) {
      return;
    }

    console.log('[ToneTransmitter] Stopping tone transmission...');

    try {
      if (this.localTrack && this.room) {
        try {
          await this.room.localParticipant.unpublishTrack(this.localTrack);
        } catch (e) {
          console.warn('[ToneTransmitter] Unpublish warning:', e.message);
        }
        
        try {
          this.localTrack.stop();
        } catch (e) {
          console.warn('[ToneTransmitter] LocalTrack stop warning:', e.message);
        }
      }
    } catch (err) {
      console.error('[ToneTransmitter] Stop error:', err);
    } finally {
      toneEngine.clearTxMode();
      this._cleanupDestination();
      this.localTrack = null;
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
    this.room = null;
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    this.mediaStreamDestination = null;
  }
}

export const toneTransmitter = new ToneTransmitter();
export default toneTransmitter;
