import { Room, Track, RoomEvent } from 'livekit-client';

const PTT_STATES = {
  IDLE: 'idle',
  ACQUIRING: 'acquiring',
  PUBLISHING: 'publishing',
  TRANSMITTING: 'transmitting',
  STOPPING: 'stopping'
};

export class MicPTTManager {
  constructor() {
    this.state = PTT_STATES.IDLE;
    this.room = null;
    this.localTrack = null;
    this.browserTrack = null;
    this.stream = null;
    this.onStateChange = null;
    this.transitionPromise = null;
  }

  setState(newState) {
    console.log(`[MicPTT] State: ${this.state} → ${newState}`);
    this.state = newState;
    if (this.onStateChange) {
      this.onStateChange(newState);
    }
  }

  isTransmitting() {
    return this.state === PTT_STATES.TRANSMITTING;
  }

  canStart() {
    return this.state === PTT_STATES.IDLE;
  }

  canStop() {
    return this.state === PTT_STATES.TRANSMITTING || 
           this.state === PTT_STATES.ACQUIRING || 
           this.state === PTT_STATES.PUBLISHING;
  }

  setRoom(room) {
    this.room = room;
  }

  async startTransmission() {
    if (!this.canStart()) {
      console.log(`[MicPTT] Cannot start, current state: ${this.state}`);
      return false;
    }

    if (!this.room) {
      console.error('[MicPTT] No room connected');
      return false;
    }

    this.transitionPromise = this._doStart();
    return this.transitionPromise;
  }

  async _doStart() {
    try {
      this.setState(PTT_STATES.ACQUIRING);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.stream = stream;
      this.browserTrack = stream.getAudioTracks()[0];

      if (this.state !== PTT_STATES.ACQUIRING) {
        console.log('[MicPTT] State changed during acquisition, aborting');
        this._cleanup();
        return false;
      }

      this.setState(PTT_STATES.PUBLISHING);

      const publication = await this.room.localParticipant.publishTrack(
        this.browserTrack,
        {
          name: 'microphone',
          source: Track.Source.Microphone
        }
      );
      this.localTrack = publication.track;

      if (this.state !== PTT_STATES.PUBLISHING) {
        console.log('[MicPTT] State changed during publishing, aborting');
        await this._unpublish();
        this._cleanup();
        return false;
      }

      this.setState(PTT_STATES.TRANSMITTING);
      console.log('[MicPTT] Transmission started');
      return true;
    } catch (err) {
      console.error('[MicPTT] Start error:', err);
      this._cleanup();
      this.setState(PTT_STATES.IDLE);
      return false;
    }
  }

  async stopTransmission() {
    if (!this.canStop()) {
      console.log(`[MicPTT] Cannot stop, current state: ${this.state}`);
      return;
    }

    if (this.transitionPromise) {
      this.setState(PTT_STATES.STOPPING);
      await this.transitionPromise;
    }

    await this._doStop();
  }

  async _doStop() {
    this.setState(PTT_STATES.STOPPING);

    try {
      await this._unpublish();
    } catch (err) {
      console.warn('[MicPTT] Unpublish error:', err);
    }

    this._cleanup();
    this.setState(PTT_STATES.IDLE);
    console.log('[MicPTT] Transmission stopped');
  }

  async _unpublish() {
    if (this.localTrack && this.room) {
      try {
        this.localTrack.stop();
        await this.room.localParticipant.unpublishTrack(this.localTrack);
      } catch (err) {
        console.warn('[MicPTT] Unpublish error:', err.message);
      }
    }
  }

  _cleanup() {
    if (this.browserTrack) {
      try {
        this.browserTrack.stop();
      } catch (e) {}
      this.browserTrack = null;
    }

    if (this.stream) {
      this.stream.getTracks().forEach(t => {
        try { t.stop(); } catch (e) {}
      });
      this.stream = null;
    }

    this.localTrack = null;
  }

  forceRelease() {
    console.log('[MicPTT] Force release');
    if (this.localTrack) {
      try { this.localTrack.stop(); } catch (e) {}
    }
    this._cleanup();
    if (this.state !== PTT_STATES.IDLE) {
      this.setState(PTT_STATES.IDLE);
    }
  }

  disconnect() {
    this.forceRelease();
    this.room = null;
  }
}

export default MicPTTManager;
