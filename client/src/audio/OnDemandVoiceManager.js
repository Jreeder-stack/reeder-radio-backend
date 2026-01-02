import { Room, RoomEvent, Track, DataPacket_Kind } from 'livekit-client';
import { getToken } from '../utils/api.js';
import { signalingManager } from '../signaling/SignalingManager.js';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;

const VOICE_STATE = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  TRANSMITTING: 'transmitting',
  RECEIVING: 'receiving',
  DISCONNECTING: 'disconnecting',
};

class OnDemandVoiceManager {
  constructor() {
    this.rooms = new Map();
    this.roomStates = new Map();
    this.pendingConnections = new Map();
    this.graceTimers = new Map();
    this.connectionTimes = new Map();
    this.activeEmergencies = new Map();
    this.emergencyTimers = new Map();
    
    this.GRACE_PERIOD_MS = 3000;
    this.TOKEN_TTL_MS = 60000;
    this.EMERGENCY_ROOM_LIFETIME_MS = 60000;
    
    this._listeners = {
      stateChange: new Set(),
      audioReceived: new Set(),
      connectionError: new Set(),
    };
    
    this.audioContext = null;
    this.audioElements = new Map();
    
    this._setupSignalingListeners();
  }

  _setupSignalingListeners() {
    signalingManager.on('pttStart', (data) => {
      if (data.unitId === signalingManager.unitId) return;
      
      console.log(`[OnDemandVoice] PTT started by ${data.unitId} on ${data.channelId}`);
      this._handleRemotePttStart(data.channelId, data.unitId, data.isEmergency);
    });

    signalingManager.on('pttEnd', (data) => {
      if (data.unitId === signalingManager.unitId) return;
      
      console.log(`[OnDemandVoice] PTT ended by ${data.unitId} on ${data.channelId}`);
      this._handleRemotePttEnd(data.channelId, data.gracePeriodMs || this.GRACE_PERIOD_MS);
    });

    signalingManager.on('emergencyStart', (data) => {
      console.log(`[OnDemandVoice] Emergency started by ${data.unitId} on ${data.channelId}`);
      this._setEmergencyActive(data.channelId, data);
      this._handleEmergencyStart(data.channelId);
    });

    signalingManager.on('emergencyEnd', (data) => {
      console.log(`[OnDemandVoice] Emergency ended on ${data.channelId}`);
      this._clearEmergencyActive(data.channelId);
    });

    signalingManager.on('emergency:force_connect', (data) => {
      console.log(`[OnDemandVoice] Emergency force-connect received for ${data.channelId}`);
      this._handleEmergencyForceConnect(data);
    });
  }

  async _handleEmergencyForceConnect(data) {
    const { channelId, roomLifetimeMs, bypassGracePeriod } = data;
    
    this._clearGraceTimer(channelId);
    
    if (this.rooms.has(channelId)) {
      console.log(`[OnDemandVoice] Already connected to ${channelId}, extending lifetime for emergency`);
      if (bypassGracePeriod) {
        this._clearGraceTimer(channelId);
      }
      return;
    }
    
    console.log(`[OnDemandVoice] Force-connecting to ${channelId} for emergency`);
    
    try {
      await this.connectForReceiving(channelId, {
        isEmergency: true,
        extendedLifetime: roomLifetimeMs,
        bypassGracePeriod,
      });
    } catch (err) {
      console.error(`[OnDemandVoice] Emergency force-connect failed:`, err.message);
    }
  }

  _getAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.warn);
    }
    return this.audioContext;
  }

  async _handleRemotePttStart(channelId, unitId, isEmergency = false) {
    this._clearGraceTimer(channelId);
    
    if (this.rooms.has(channelId)) {
      console.log(`[OnDemandVoice] Already connected to ${channelId} for receiving`);
      return;
    }
    
    if (this.pendingConnections.has(channelId)) {
      console.log(`[OnDemandVoice] Connection already pending for ${channelId}`);
      return;
    }
    
    try {
      await this._connectToReceive(channelId);
    } catch (err) {
      console.error(`[OnDemandVoice] Failed to connect for receiving on ${channelId}:`, err);
      this._emit('connectionError', { channelId, error: err });
    }
  }

  async _handleRemotePttEnd(channelId, gracePeriodMs) {
    if (this.activeEmergencies.has(channelId)) {
      console.log(`[OnDemandVoice] Skipping grace timer for ${channelId} - emergency active`);
      return;
    }
    
    console.log(`[OnDemandVoice] Starting grace period for ${channelId}: ${gracePeriodMs}ms`);
    this._startGraceTimer(channelId, gracePeriodMs);
  }
  
  _setEmergencyActive(channelId, emergencyData) {
    this.activeEmergencies.set(channelId, {
      ...emergencyData,
      activatedAt: Date.now(),
    });
    
    this._clearGraceTimer(channelId);
    
    this._clearEmergencyTimer(channelId);
    const timerId = setTimeout(() => {
      console.log(`[OnDemandVoice] Emergency timer expired for ${channelId}`);
      this._clearEmergencyActive(channelId);
    }, emergencyData.expiresAt ? (emergencyData.expiresAt - Date.now()) : this.EMERGENCY_ROOM_LIFETIME_MS);
    this.emergencyTimers.set(channelId, timerId);
    
    console.log(`[OnDemandVoice] Emergency activated for ${channelId}`);
  }
  
  _clearEmergencyActive(channelId) {
    this.activeEmergencies.delete(channelId);
    this._clearEmergencyTimer(channelId);
    
    if (this.rooms.has(channelId)) {
      console.log(`[OnDemandVoice] Emergency cleared for ${channelId}, starting grace period`);
      this._startGraceTimer(channelId, this.GRACE_PERIOD_MS);
    }
  }
  
  _clearEmergencyTimer(channelId) {
    const timerId = this.emergencyTimers.get(channelId);
    if (timerId) {
      clearTimeout(timerId);
      this.emergencyTimers.delete(channelId);
    }
  }
  
  isEmergencyActive(channelId) {
    return this.activeEmergencies.has(channelId);
  }

  async _handleEmergencyStart(channelId) {
    this._clearGraceTimer(channelId);
    
    if (!this.rooms.has(channelId)) {
      try {
        await this._connectToReceive(channelId);
      } catch (err) {
        console.error(`[OnDemandVoice] Failed to connect for emergency on ${channelId}:`, err);
      }
    }
  }

  _startGraceTimer(channelId, gracePeriodMs) {
    if (this.activeEmergencies.has(channelId)) {
      console.log(`[OnDemandVoice] Grace timer blocked for ${channelId} - emergency active`);
      return;
    }
    
    this._clearGraceTimer(channelId);
    
    const timerId = setTimeout(() => {
      this.graceTimers.delete(channelId);
      
      if (this.activeEmergencies.has(channelId)) {
        console.log(`[OnDemandVoice] Grace period skip for ${channelId} - emergency became active`);
        return;
      }
      
      const state = this.roomStates.get(channelId);
      
      if (state === VOICE_STATE.RECEIVING) {
        console.log(`[OnDemandVoice] Grace period expired for ${channelId}, disconnecting`);
        this._disconnectRoom(channelId);
      }
    }, gracePeriodMs);
    
    this.graceTimers.set(channelId, timerId);
  }

  _clearGraceTimer(channelId) {
    const timerId = this.graceTimers.get(channelId);
    if (timerId) {
      clearTimeout(timerId);
      this.graceTimers.delete(channelId);
    }
  }

  async startTransmission(channelId, identity) {
    console.log(`[OnDemandVoice] Starting transmission on ${channelId} as ${identity}`);
    
    this._clearGraceTimer(channelId);
    
    if (!signalingManager.isLivekitAvailable()) {
      throw new Error('Voice service unavailable');
    }
    
    if (!signalingManager.signalPttStart(channelId)) {
      throw new Error('Failed to signal PTT start');
    }
    
    let room = this.rooms.get(channelId);
    
    if (!room || room.state !== 'connected') {
      try {
        room = await this._connectRoom(channelId, identity);
      } catch (err) {
        signalingManager.signalPttEnd(channelId);
        throw err;
      }
    }
    
    this._setState(channelId, VOICE_STATE.TRANSMITTING);
    this._recordConnectionStart(channelId);
    
    return room;
  }

  async endTransmission(channelId) {
    console.log(`[OnDemandVoice] Ending transmission on ${channelId}`);
    
    signalingManager.signalPttEnd(channelId);
    
    const state = this.roomStates.get(channelId);
    if (state === VOICE_STATE.TRANSMITTING) {
      this._setState(channelId, VOICE_STATE.CONNECTED);
      this._startGraceTimer(channelId, this.GRACE_PERIOD_MS);
    }
  }

  async _connectRoom(channelId, identity) {
    if (this.pendingConnections.has(channelId)) {
      return this.pendingConnections.get(channelId);
    }
    
    const connectionPromise = (async () => {
      this._setState(channelId, VOICE_STATE.CONNECTING);
      
      const room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      
      this._setupRoomHandlers(room, channelId);
      
      try {
        const token = await getToken(identity, channelId);
        await room.connect(LIVEKIT_URL, token);
        
        this.rooms.set(channelId, room);
        this._setState(channelId, VOICE_STATE.CONNECTED);
        
        console.log(`[OnDemandVoice] Connected to ${channelId}`);
        return room;
      } catch (err) {
        this._setState(channelId, VOICE_STATE.DISCONNECTED);
        throw err;
      }
    })();
    
    this.pendingConnections.set(channelId, connectionPromise);
    
    try {
      return await connectionPromise;
    } finally {
      this.pendingConnections.delete(channelId);
    }
  }

  async _connectToReceive(channelId) {
    const identity = signalingManager.unitId || 'listener';
    
    if (this.rooms.has(channelId)) {
      this._setState(channelId, VOICE_STATE.RECEIVING);
      return this.rooms.get(channelId);
    }
    
    const room = await this._connectRoom(channelId, identity);
    this._setState(channelId, VOICE_STATE.RECEIVING);
    this._recordConnectionStart(channelId);
    
    return room;
  }

  _setupRoomHandlers(room, channelId) {
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      if (participant.identity === room.localParticipant?.identity) return;
      
      console.log(`[OnDemandVoice] Audio track from ${participant.identity} on ${channelId}`);
      
      const audioElem = track.attach();
      audioElem.autoplay = true;
      audioElem.playsInline = true;
      
      const currentState = this.roomStates.get(channelId);
      if (currentState === VOICE_STATE.TRANSMITTING) {
        audioElem.muted = true;
      }
      
      audioElem.play().catch(console.warn);
      
      if (!this.audioElements.has(channelId)) {
        this.audioElements.set(channelId, new Set());
      }
      this.audioElements.get(channelId).add(audioElem);
      
      this._emit('audioReceived', { channelId, track, participant, audioElem });
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      
      const elements = track.detach();
      const channelElements = this.audioElements.get(channelId);
      if (channelElements) {
        elements.forEach(el => channelElements.delete(el));
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log(`[OnDemandVoice] Disconnected from ${channelId}`);
      this._cleanupRoom(channelId);
    });

    room.on(RoomEvent.Reconnecting, () => {
      console.log(`[OnDemandVoice] Reconnecting to ${channelId}`);
    });

    room.on(RoomEvent.Reconnected, () => {
      console.log(`[OnDemandVoice] Reconnected to ${channelId}`);
    });
  }

  async _disconnectRoom(channelId) {
    const room = this.rooms.get(channelId);
    if (!room) return;
    
    this._setState(channelId, VOICE_STATE.DISCONNECTING);
    this._recordConnectionEnd(channelId);
    
    try {
      const elements = this.audioElements.get(channelId);
      if (elements) {
        elements.forEach(el => {
          el.pause();
          el.srcObject = null;
          el.remove();
        });
        this.audioElements.delete(channelId);
      }
      
      await room.disconnect();
    } catch (err) {
      console.warn(`[OnDemandVoice] Disconnect error for ${channelId}:`, err);
    }
    
    this._cleanupRoom(channelId);
  }

  _cleanupRoom(channelId) {
    this.rooms.delete(channelId);
    this._setState(channelId, VOICE_STATE.DISCONNECTED);
    this._clearGraceTimer(channelId);
  }

  _setState(channelId, state) {
    const oldState = this.roomStates.get(channelId);
    this.roomStates.set(channelId, state);
    
    if (oldState !== state) {
      this._emit('stateChange', { channelId, state, oldState });
    }
  }

  _recordConnectionStart(channelId) {
    this.connectionTimes.set(channelId, Date.now());
  }

  _recordConnectionEnd(channelId) {
    const startTime = this.connectionTimes.get(channelId);
    if (startTime) {
      const duration = Date.now() - startTime;
      this.connectionTimes.delete(channelId);
      console.log(`[OnDemandVoice] Connection time for ${channelId}: ${duration}ms`);
      
      this._reportConnectionTime(channelId, duration);
    }
  }

  async _reportConnectionTime(channelId, durationMs) {
    try {
      await fetch('/api/dispatch/connection-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          unitId: signalingManager.unitId,
          channelId,
          durationMs,
        }),
      });
    } catch (err) {
      console.warn('[OnDemandVoice] Failed to report connection time:', err.message);
    }
  }

  getRoom(channelId) {
    return this.rooms.get(channelId);
  }

  getState(channelId) {
    return this.roomStates.get(channelId) || VOICE_STATE.DISCONNECTED;
  }

  isConnected(channelId) {
    const state = this.getState(channelId);
    return state !== VOICE_STATE.DISCONNECTED && state !== VOICE_STATE.DISCONNECTING;
  }

  isTransmitting(channelId) {
    return this.getState(channelId) === VOICE_STATE.TRANSMITTING;
  }

  muteReceiveAudio(channelId, muted) {
    const elements = this.audioElements.get(channelId);
    if (elements) {
      elements.forEach(el => {
        el.muted = muted;
      });
    }
  }

  muteAllReceiveAudio(muted) {
    for (const [channelId] of this.audioElements) {
      this.muteReceiveAudio(channelId, muted);
    }
  }

  on(event, callback) {
    if (!this._listeners[event]) {
      console.warn(`[OnDemandVoice] Unknown event: ${event}`);
      return () => {};
    }
    this._listeners[event].add(callback);
    return () => this._listeners[event].delete(callback);
  }

  _emit(event, data) {
    if (!this._listeners[event]) return;
    for (const listener of this._listeners[event]) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[OnDemandVoice] Listener error for ${event}:`, err);
      }
    }
  }

  async disconnectAll() {
    const channels = Array.from(this.rooms.keys());
    await Promise.all(channels.map(ch => this._disconnectRoom(ch)));
  }

  destroy() {
    this.disconnectAll();
    for (const timerId of this.graceTimers.values()) {
      clearTimeout(timerId);
    }
    this.graceTimers.clear();
    if (this.audioContext) {
      this.audioContext.close().catch(console.warn);
    }
  }
}

export const onDemandVoiceManager = new OnDemandVoiceManager();
export { VOICE_STATE };
