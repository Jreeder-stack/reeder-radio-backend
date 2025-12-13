import { Track } from 'livekit-client';
import { PTT_STATES } from '../constants/pttStates.js';
import { playPermitTone, startBonkLoop, stopBonkLoop } from './talkPermitTone.js';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || 
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

class MicPTTManager {
  constructor() {
    this.state = PTT_STATES.IDLE;
    this.audioContext = null;
    this.stream = null;
    this.browserTrack = null;
    this.localTrack = null;
    this.room = null;
    this.onStateChange = null;
    this.onError = null;
    this.pendingStop = false;
    this.transitionLock = false;
  }

  getState() {
    return this.state;
  }

  isTransmitting() {
    return this.state === PTT_STATES.TRANSMITTING;
  }

  canStart() {
    return this.state === PTT_STATES.IDLE && !this.transitionLock;
  }

  canStop() {
    return this.state === PTT_STATES.TRANSMITTING || 
           this.state === PTT_STATES.ARMING ||
           this.state === PTT_STATES.BUSY;
  }

  _setState(newState) {
    const oldState = this.state;
    this.state = newState;
    console.log(`[MicPTT] State: ${oldState} → ${newState}`);
    if (this.onStateChange) {
      this.onStateChange(newState, oldState);
    }
  }

  _ensureAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(e => console.warn('[MicPTT] AudioContext resume failed:', e));
    }
    return this.audioContext;
  }

  setRoom(room) {
    this.room = room;
  }

  async start() {
    if (!this.canStart()) {
      console.log(`[MicPTT] Cannot start - state: ${this.state}, lock: ${this.transitionLock}`);
      return false;
    }

    if (!this.room) {
      console.error('[MicPTT] No room connected');
      return false;
    }

    this.transitionLock = true;
    this.pendingStop = false;

    try {
      this._setState(PTT_STATES.ARMING);
      this._ensureAudioContext();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during mic acquisition - aborting');
        this._stopTracks(stream);
        this._setState(PTT_STATES.IDLE);
        this.transitionLock = false;
        return false;
      }

      this.stream = stream;
      this.browserTrack = stream.getAudioTracks()[0];

      console.log('[MicPTT] Publishing track to room...');
      const publication = await this.room.localParticipant.publishTrack(
        this.browserTrack,
        {
          name: 'microphone',
          source: Track.Source.Microphone
        }
      );
      this.localTrack = publication.track;

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during publish - cleaning up');
        await this._doStop();
        return false;
      }

      this._setState(PTT_STATES.TRANSMITTING);
      this.transitionLock = false;
      console.log('[MicPTT] Transmission active');
      playPermitTone();
      return true;

    } catch (err) {
      console.error('[MicPTT] Start failed:', err);
      startBonkLoop();
      await this._cleanup();
      this._setState(PTT_STATES.BUSY);
      this.transitionLock = false;
      if (this.onError) {
        this.onError(err);
      }
      return false;
    }
  }

  async stop() {
    console.log(`[MicPTT] Stop requested - state: ${this.state}`);

    stopBonkLoop();

    if (this.state === PTT_STATES.IDLE) {
      return;
    }

    if (this.state === PTT_STATES.BUSY) {
      this._setState(PTT_STATES.IDLE);
      return;
    }

    if (this.state === PTT_STATES.ARMING) {
      console.log('[MicPTT] Setting pendingStop flag');
      this.pendingStop = true;
      return;
    }

    if (this.state === PTT_STATES.COOLDOWN) {
      return;
    }

    await this._doStop();
  }

  async _doStop() {
    this._setState(PTT_STATES.COOLDOWN);

    try {
      if (this.localTrack && this.room) {
        console.log('[MicPTT] Unpublishing track...');
        try {
          this.localTrack.stop();
        } catch (e) {
          console.warn('[MicPTT] LocalTrack stop warning:', e.message);
        }
        try {
          await this.room.localParticipant.unpublishTrack(this.localTrack);
        } catch (e) {
          console.warn('[MicPTT] Unpublish warning:', e.message);
        }
      }

      this._cleanup();

    } catch (err) {
      console.error('[MicPTT] Stop error:', err);
    } finally {
      this.pendingStop = false;
      this.transitionLock = false;
      this._setState(PTT_STATES.IDLE);
      console.log('[MicPTT] Transmission ended, state reset to IDLE');
    }
  }

  async _cleanup() {
    if (this.browserTrack) {
      try {
        this.browserTrack.stop();
        console.log('[MicPTT] Browser track stopped');
      } catch (e) {}
      this.browserTrack = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        try { 
          t.stop(); 
        } catch (e) {}
      });
      this.stream = null;
    }

    this.localTrack = null;
  }

  _stopTracks(stream) {
    if (stream) {
      stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
    }
  }

  forceRelease() {
    console.log('[MicPTT] Force release');
    
    if (this.localTrack) {
      try { this.localTrack.stop(); } catch (e) {}
    }
    
    this._cleanup();
    this.pendingStop = false;
    this.transitionLock = false;
    
    if (this.state !== PTT_STATES.IDLE) {
      this._setState(PTT_STATES.IDLE);
    }
  }

  disconnect() {
    this.forceRelease();
    this.room = null;
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
  }
}

export const micPTTManager = new MicPTTManager();
export { PTT_STATES };
export default micPTTManager;
