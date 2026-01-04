import { Track, RoomEvent } from 'livekit-client';
import { PTT_STATES } from '../constants/pttStates.js';
import { playPermitTone, startBonkLoop, stopBonkLoop } from './talkPermitTone.js';
import { unlockAudio } from './iosAudioUnlock.js';
import { processRadioVoice, cleanup as cleanupRadioDSP } from './radioVoiceDSP.js';

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || 
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const PERMIT_TONE_DURATION = 150;

const PTT_COOLDOWN_MS = 500;
const PTT_READY_TIMEOUT_MS = 5000;

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
    this.onDisconnectDuringTx = null;
    this.pendingStop = false;
    this.transitionLock = false;
    this.permitDeadlineTimer = null;
    this.publishComplete = false;
    this.lastPttEndTime = 0;
    this.stateListeners = new Set();
    this._roomDisconnectHandler = null;
    this._roomReconnectingHandler = null;
    this._signalingManager = null;
    this._pttReadyResolver = null;
    this._currentChannelId = null;
    this._currentUnitId = null;
    
    this._audioBuffer = [];
    this._isBuffering = false;
    this._mediaRecorder = null;
    this._roomResolver = null;
    this._waitingForRoom = false;
  }

  setSignalingManager(signalingManager) {
    this._signalingManager = signalingManager;
  }

  setCurrentChannel(channelId) {
    this._currentChannelId = channelId;
  }

  setCurrentUnit(unitId) {
    this._currentUnitId = unitId;
  }

  _waitForPttReady() {
    return new Promise((resolve) => {
      if (!this._signalingManager) {
        console.log('[MicPTT] No signaling manager - proceeding immediately');
        resolve(false);
        return;
      }

      let timeout = null;
      let unsubscribe = null;

      const onReady = (data) => {
        const channelMatch = !this._currentChannelId || data.channelId === this._currentChannelId;
        const unitMatch = !this._currentUnitId || data.unitId === this._currentUnitId;
        
        if (channelMatch && unitMatch) {
          console.log(`[MicPTT] PTT_READY received for ${data.unitId} on ${data.channelId}`);
          if (timeout) clearTimeout(timeout);
          if (unsubscribe) unsubscribe();
          this._pttReadyResolver = null;
          resolve(true);
        }
      };

      unsubscribe = this._signalingManager.on('pttReady', onReady);

      timeout = setTimeout(() => {
        console.log('[MicPTT] PTT_READY timeout - proceeding anyway');
        if (unsubscribe) unsubscribe();
        this._pttReadyResolver = null;
        resolve(false);
      }, PTT_READY_TIMEOUT_MS);

      this._pttReadyResolver = { resolve, timeout, unsubscribe };
    });
  }

  _cancelPttReadyWait() {
    if (this._pttReadyResolver) {
      if (this._pttReadyResolver.timeout) clearTimeout(this._pttReadyResolver.timeout);
      if (this._pttReadyResolver.unsubscribe) this._pttReadyResolver.unsubscribe();
      if (this._pttReadyResolver.resolve) this._pttReadyResolver.resolve(false);
      this._pttReadyResolver = null;
    }
  }

  addStateListener(callback) {
    this.stateListeners.add(callback);
    return () => this.stateListeners.delete(callback);
  }

  removeStateListener(callback) {
    this.stateListeners.delete(callback);
  }

  getState() {
    return this.state;
  }

  isTransmitting() {
    return this.state === PTT_STATES.TRANSMITTING;
  }

  canStart() {
    if (this.state !== PTT_STATES.IDLE || this.transitionLock) {
      return false;
    }
    const timeSinceLastEnd = Date.now() - this.lastPttEndTime;
    if (timeSinceLastEnd < PTT_COOLDOWN_MS) {
      console.log(`[MicPTT] Cooldown active - ${PTT_COOLDOWN_MS - timeSinceLastEnd}ms remaining`);
      return false;
    }
    return true;
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
    this.stateListeners.forEach(listener => {
      try {
        listener(newState, oldState);
      } catch (e) {
        console.error('[MicPTT] State listener error:', e);
      }
    });
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
    this._removeRoomListeners();
    this.room = room;
    
    if (this._waitingForRoom && this._roomResolver) {
      console.log('[MicPTT] Room received while waiting - resolving promise');
      this._roomResolver(room);
      this._roomResolver = null;
      this._waitingForRoom = false;
    }
  }
  
  _waitForRoom(timeoutMs = 5000) {
    if (this.room && this.room.state === 'connected') {
      return Promise.resolve(this.room);
    }
    
    this._waitingForRoom = true;
    
    return new Promise((resolve, reject) => {
      this._roomRejecter = reject;
      
      this._roomWaitTimeout = setTimeout(() => {
        if (this._waitingForRoom) {
          this._waitingForRoom = false;
          this._roomResolver = null;
          this._roomRejecter = null;
          this._roomWaitTimeout = null;
          reject(new Error('Room connection timeout'));
        }
      }, timeoutMs);
      
      this._roomResolver = (room) => {
        if (this._roomWaitTimeout) {
          clearTimeout(this._roomWaitTimeout);
          this._roomWaitTimeout = null;
        }
        this._roomRejecter = null;
        resolve(room);
      };
    });
  }
  
  _cancelRoomWait() {
    if (this._roomWaitTimeout) {
      clearTimeout(this._roomWaitTimeout);
      this._roomWaitTimeout = null;
    }
    if (this._roomRejecter) {
      this._roomRejecter(new Error('Room wait cancelled'));
      this._roomRejecter = null;
    }
    this._waitingForRoom = false;
    this._roomResolver = null;
  }

  _setupRoomListeners() {
    if (!this.room) return;
    
    this._roomDisconnectHandler = () => {
      console.warn('[MicPTT] Room disconnected during transmission!');
      this._handleDisconnectDuringTx();
    };
    
    this._roomReconnectingHandler = () => {
      console.warn('[MicPTT] Room reconnecting during transmission');
    };
    
    this.room.on(RoomEvent.Disconnected, this._roomDisconnectHandler);
    this.room.on(RoomEvent.Reconnecting, this._roomReconnectingHandler);
  }

  _removeRoomListeners() {
    if (this.room) {
      if (this._roomDisconnectHandler) {
        this.room.off(RoomEvent.Disconnected, this._roomDisconnectHandler);
      }
      if (this._roomReconnectingHandler) {
        this.room.off(RoomEvent.Reconnecting, this._roomReconnectingHandler);
      }
    }
    this._roomDisconnectHandler = null;
    this._roomReconnectingHandler = null;
  }

  _handleDisconnectDuringTx() {
    // If we're transmitting, clean up immediately
    if (this.state === PTT_STATES.TRANSMITTING || this.state === PTT_STATES.ARMING) {
      console.error('[MicPTT] Disconnected during active transmission - forcing cleanup');
      
      // Play error tone to alert user
      if (this.onDisconnectDuringTx) {
        this.onDisconnectDuringTx();
      }
      
      // Force cleanup
      this.forceRelease();
    }
  }

  _clearPermitDeadline() {
    if (this.permitDeadlineTimer) {
      clearTimeout(this.permitDeadlineTimer);
      this.permitDeadlineTimer = null;
    }
  }

  async start() {
    if (!this.canStart()) {
      console.log(`[MicPTT] Cannot start - state: ${this.state}, lock: ${this.transitionLock}`);
      return false;
    }

    unlockAudio();

    this.transitionLock = true;
    this.pendingStop = false;

    try {
      this._setState(PTT_STATES.ARMING);
      this._ensureAudioContext();
      
      playPermitTone();
      console.log('[MicPTT] Permit tone played immediately');

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
      
      const processedStream = processRadioVoice(stream);
      this.browserTrack = processedStream.getAudioTracks()[0];
      console.log('[MicPTT] Mic acquired with radio voice DSP');

      let room = this.room;
      if (!room || room.state !== 'connected') {
        console.log('[MicPTT] Waiting for room connection...');
        try {
          room = await this._waitForRoom(PTT_READY_TIMEOUT_MS);
          this.room = room;
        } catch (roomErr) {
          console.error('[MicPTT] Room connection failed:', roomErr);
          startBonkLoop();
          await this._cleanup();
          this.transitionLock = false;
          if (this.pendingStop) {
            stopBonkLoop();
            this.pendingStop = false;
            this._setState(PTT_STATES.IDLE);
          } else {
            this._setState(PTT_STATES.BUSY);
          }
          if (this.onError) {
            this.onError(roomErr);
          }
          return false;
        }
      }

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during room wait - aborting');
        this._stopTracks(stream);
        this._setState(PTT_STATES.IDLE);
        this.transitionLock = false;
        return false;
      }

      this._setupRoomListeners();
      this.publishComplete = false;
      console.log('[MicPTT] Room ready, publishing track...');
      
      this.permitDeadlineTimer = setTimeout(() => {
        if (!this.publishComplete && this.state === PTT_STATES.ARMING && !this.pendingStop) {
          console.log('[MicPTT] Publish taking too long, starting bonk');
          startBonkLoop();
        }
      }, 2000);
      
      try {
        const publication = await this.room.localParticipant.publishTrack(
          this.browserTrack,
          {
            name: 'microphone',
            source: Track.Source.Microphone
          }
        );
        this.localTrack = publication.track;
        this.publishComplete = true;
        this._clearPermitDeadline();
        stopBonkLoop();
      } catch (publishErr) {
        console.error('[MicPTT] Publish failed:', publishErr);
        this._clearPermitDeadline();
        startBonkLoop();
        await this._cleanup();
        this.transitionLock = false;
        if (this.pendingStop) {
          stopBonkLoop();
          this.pendingStop = false;
          this._setState(PTT_STATES.IDLE);
        } else {
          this._setState(PTT_STATES.BUSY);
        }
        if (this.onError) {
          this.onError(publishErr);
        }
        return false;
      }

      if (this.pendingStop) {
        console.log('[MicPTT] Stop requested during publish - cleaning up');
        await this._doStop();
        return false;
      }

      this._setState(PTT_STATES.TRANSMITTING);
      this.transitionLock = false;
      console.log('[MicPTT] Transmission active');
      return true;

    } catch (err) {
      console.error('[MicPTT] Start failed (mic access):', err);
      startBonkLoop();
      await this._cleanup();
      this.transitionLock = false;
      if (this.pendingStop) {
        stopBonkLoop();
        this.pendingStop = false;
        this._setState(PTT_STATES.IDLE);
      } else {
        this._setState(PTT_STATES.BUSY);
      }
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
      this._cancelPttReadyWait();
      this._cancelRoomWait();
      return;
    }

    if (this.state === PTT_STATES.COOLDOWN) {
      return;
    }

    await this._doStop();
  }

  async _doStop() {
    this._setState(PTT_STATES.COOLDOWN);

    // Remove room listeners immediately to prevent duplicate cleanup
    this._removeRoomListeners();

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
      this.lastPttEndTime = Date.now();
      this._setState(PTT_STATES.IDLE);
      console.log('[MicPTT] Transmission ended, state reset to IDLE');
    }
  }

  async _cleanup() {
    this._clearPermitDeadline();
    this._cancelRoomWait();
    this.publishComplete = false;
    stopBonkLoop();
    cleanupRadioDSP();
    
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
    
    this._clearPermitDeadline();
    this._removeRoomListeners();
    this._cancelRoomWait();
    this._cancelPttReadyWait();
    stopBonkLoop();
    
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
