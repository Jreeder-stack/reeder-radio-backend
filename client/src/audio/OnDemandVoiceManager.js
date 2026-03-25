import { signalingManager } from '../signaling/SignalingManager.js';

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

    this.GRACE_PERIOD_MS = 15000;
    this.EMERGENCY_ROOM_LIFETIME_MS = 60000;
    this._dispatcherMode = false;
    this._reconnectAttempts = new Map();
    this._reconnectTimers = new Map();
    this._RECONNECT_BASE_DELAY = 1000;
    this._RECONNECT_MAX_DELAY = 30000;
    this._RECONNECT_MAX_ATTEMPTS = 20;

    this._listeners = {
      stateChange: new Set(),
      audioReceived: new Set(),
      connectionError: new Set(),
    };

    this.audioContext = null;
    this._playbackNodes = new Map();
    this._workletReady = false;

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
    const { channelId, bypassGracePeriod } = data;

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
        bypassGracePeriod,
      });
    } catch (err) {
      console.error(`[OnDemandVoice] Emergency force-connect failed:`, err.message);
    }
  }

  _getAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    }
    if (this.audioContext.state === 'suspended') {
      this.audioContext.resume().catch(console.warn);
    }
    return this.audioContext;
  }

  async _ensurePlaybackWorklet() {
    if (this._workletReady) return;
    const ctx = this._getAudioContext();
    await ctx.audioWorklet.addModule('/audio/pcm-playback-worklet.js');
    this._workletReady = true;
  }

  async _handleRemotePttStart(channelId, unitId, isEmergency = false) {
    this._clearGraceTimer(channelId);

    if (this._dispatcherMode) {
      return;
    }

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

  setDispatcherMode(enabled) {
    this._dispatcherMode = !!enabled;
    if (this._dispatcherMode) {
      for (const [channelId, timerId] of this.graceTimers) {
        clearTimeout(timerId);
      }
      this.graceTimers.clear();
    } else {
      for (const [channelId, timerId] of this._reconnectTimers) {
        clearTimeout(timerId);
      }
      this._reconnectTimers.clear();
      this._reconnectAttempts.clear();
    }
    console.log(`[OnDemandVoice] Dispatcher mode ${this._dispatcherMode ? 'enabled' : 'disabled'} — grace period disconnect ${this._dispatcherMode ? 'disabled' : 'enabled'}`);
  }

  _scheduleDispatcherReconnect(channelId) {
    if (!this._dispatcherMode) return;

    const existingTimer = this._reconnectTimers.get(channelId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    let attempts = this._reconnectAttempts.get(channelId) || 0;
    if (attempts >= this._RECONNECT_MAX_ATTEMPTS) {
      console.log(`[OnDemandVoice] Dispatcher auto-reconnect: resetting attempt counter for ${channelId} (always-connected mode)`);
      attempts = 0;
      this._reconnectAttempts.set(channelId, 0);
    }

    const baseDelay = this._RECONNECT_BASE_DELAY * Math.pow(2, Math.min(attempts, 5));
    const jitter = Math.random() * 1000;
    const delay = Math.min(baseDelay + jitter, this._RECONNECT_MAX_DELAY);

    console.log(`[OnDemandVoice] Dispatcher auto-reconnect: scheduling ${channelId} in ${Math.round(delay)}ms (attempt ${attempts + 1})`);

    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(channelId);

      if (!this._dispatcherMode) return;
      if (this.rooms.has(channelId)) return;

      this._reconnectAttempts.set(channelId, attempts + 1);

      try {
        await this._connectToReceive(channelId);
        console.log(`[OnDemandVoice] Dispatcher auto-reconnect: successfully reconnected to ${channelId}`);
        this._reconnectAttempts.delete(channelId);
      } catch (err) {
        console.error(`[OnDemandVoice] Dispatcher auto-reconnect: failed for ${channelId}:`, err.message);
        this._scheduleDispatcherReconnect(channelId);
      }
    }, delay);

    this._reconnectTimers.set(channelId, timer);
  }

  _startGraceTimer(channelId, gracePeriodMs) {
    if (this._dispatcherMode) return;

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

    try {
      await signalingManager.signalPttStart(channelId);
    } catch (grantErr) {
      throw new Error(`PTT floor denied: ${grantErr.message}`);
    }

    let conn = this.rooms.get(channelId);

    if (!conn || (conn.ws && conn.ws.readyState !== WebSocket.OPEN)) {
      try {
        conn = await this._connectRoom(channelId, identity);
      } catch (err) {
        signalingManager.signalPttEnd(channelId);
        throw err;
      }
    }

    this._setState(channelId, VOICE_STATE.TRANSMITTING);
    this._recordConnectionStart(channelId);

    return conn;
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

      try {
        await this._ensurePlaybackWorklet();

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${proto}//${window.location.host}/api/audio-ws?channelId=${encodeURIComponent(channelId)}&unitId=${encodeURIComponent(identity)}`;

        const ws = await this._openWebSocket(wsUrl);
        const conn = { ws, channelId, unitId: identity };

        this._setupWsHandlers(ws, channelId);
        this._setupPlaybackChain(channelId);

        this.rooms.set(channelId, conn);
        this._setState(channelId, VOICE_STATE.CONNECTED);

        console.log(`[OnDemandVoice] Connected to ${channelId}`);
        return conn;
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

    const conn = await this._connectRoom(channelId, identity);
    this._setState(channelId, VOICE_STATE.RECEIVING);
    this._recordConnectionStart(channelId);

    return conn;
  }

  async connectForReceiving(channelId, options = {}) {
    return this._connectToReceive(channelId);
  }

  _openWebSocket(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const onOpen = () => {
        ws.removeEventListener('error', onError);
        resolve(ws);
      };
      const onError = () => {
        ws.removeEventListener('open', onOpen);
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
  }

  _setupWsHandlers(ws, channelId) {
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') return;
      this._handleBinaryMessage(channelId, event.data);
    });

    ws.addEventListener('close', () => {
      console.log(`[OnDemandVoice] Disconnected from ${channelId}`);
      this._cleanupRoom(channelId);

      if (this._dispatcherMode) {
        console.log(`[OnDemandVoice] Dispatcher mode: auto-reconnecting ${channelId}`);
        this._scheduleDispatcherReconnect(channelId);
      }
    });
  }

  _handleBinaryMessage(channelId, data) {
    if (data.byteLength < 6) return;

    const currentState = this.roomStates.get(channelId);
    if (currentState === VOICE_STATE.TRANSMITTING) return;

    const pcmData = new Int16Array(data.slice(4));

    const playback = this._playbackNodes.get(channelId);
    if (playback && playback.workletNode) {
      playback.workletNode.port.postMessage({ type: 'pcm', samples: pcmData }, [pcmData.buffer]);
    }

    this._emit('audioReceived', { channelId });
  }

  _setupPlaybackChain(channelId) {
    const ctx = this._getAudioContext();

    const workletNode = new AudioWorkletNode(ctx, 'pcm-playback-processor');
    const gainNode = ctx.createGain();

    workletNode.connect(gainNode);
    gainNode.connect(ctx.destination);

    this._playbackNodes.set(channelId, { workletNode, gainNode });
  }

  _cleanupPlayback(channelId) {
    const playback = this._playbackNodes.get(channelId);
    if (playback) {
      try { playback.workletNode.disconnect(); } catch (e) {}
      try { playback.gainNode.disconnect(); } catch (e) {}
      this._playbackNodes.delete(channelId);
    }
  }

  async _disconnectRoom(channelId) {
    const conn = this.rooms.get(channelId);
    if (!conn) return;

    this._setState(channelId, VOICE_STATE.DISCONNECTING);
    this._recordConnectionEnd(channelId);

    try {
      this._cleanupPlayback(channelId);

      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
    } catch (err) {
      console.warn(`[OnDemandVoice] Disconnect error for ${channelId}:`, err);
    }

    this._cleanupRoom(channelId);
  }

  _cleanupRoom(channelId) {
    this.rooms.delete(channelId);
    this._cleanupPlayback(channelId);
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
    const playback = this._playbackNodes.get(channelId);
    if (playback) {
      playback.gainNode.gain.value = muted ? 0 : 1;
    }
  }

  muteAllReceiveAudio(muted) {
    for (const [channelId] of this._playbackNodes) {
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
    for (const timerId of this._reconnectTimers.values()) {
      clearTimeout(timerId);
    }
    this._reconnectTimers.clear();
    this._reconnectAttempts.clear();
    if (this.audioContext) {
      this.audioContext.close().catch(console.warn);
    }
  }
}

export const onDemandVoiceManager = new OnDemandVoiceManager();
export { VOICE_STATE };
