import { notifyChannelJoin } from '../utils/api.js';
import { micPTTManager, PTT_STATES } from './MicPTTManager.js';
import { isNativeLiveKitAvailable, nativeConnect, nativeDisconnect, updateServiceConnectionInfo } from '../plugins/nativeLiveKit.js';
import { signalingManager } from '../signaling/SignalingManager.js';

const isNativeAndroid = () => isNativeLiveKitAvailable();

class LiveKitManager {
  constructor() {
    this.rooms = new Map();
    this.channelGainNodes = new Map();
    this.levelAnimations = new Map();
    this.mutedChannels = new Set();
    this.fallbackAudioElements = new Map();
    this.disconnectPromise = null;
    this.pendingConnections = new Map();
    this.autoPlaybackEnabled = true;
    this.pttMuted = false;
    this.pttListenerRemover = null;
    this.primaryTxChannel = null;

    this._playbackNodes = new Map();
    this._workletReady = false;
    this._rxFrameCounters = new Map();
    this._prePlaybackBuffers = new Map();

    this._audioSettings = {
      incomingVolume: 80,
      playbackAmplifierEnabled: false,
      playbackAmplifierLevel: 50,
      autoIncreaseVolumeEnabled: false,
      autoIncreaseVolumeLevel: 100,
    };
    this._settingsListener = null;
    this._lastRxActivityTime = Date.now();
    this._autoVolumeBoostActive = false;
    this._autoVolumeCheckInterval = null;

    this.connectionHealth = new Map();
    this.healthCheckInterval = null;
    this.HEALTH_CHECK_INTERVAL = 5000;
    this.CONNECTION_TIMEOUT = 15000;

    this.channelLastActivity = new Map();
    this.activeChannels = new Set();
    this.idleTimeoutTimers = new Map();
    this.IDLE_TIMEOUT_MS = 60000;
    this.idleCheckInterval = null;
    this._dispatcherMode = false;

    this._reconnectAttempts = new Map();
    this._reconnectTimers = new Map();
    this._RECONNECT_BASE_DELAY = 1000;
    this._RECONNECT_MAX_DELAY = 30000;
    this._RECONNECT_MAX_ATTEMPTS = 20;

    this._trackSubscribedListeners = new Set();
    this._trackUnsubscribedListeners = new Set();
    this._participantConnectedListeners = new Set();
    this._participantDisconnectedListeners = new Set();
    this._dataReceivedListeners = new Set();
    this._levelUpdateListeners = new Set();
    this._connectionStateChangeListeners = new Set();
    this._healthChangeListeners = new Set();

    this.onTrackSubscribed = null;
    this.onTrackUnsubscribed = null;
    this.onParticipantConnected = null;
    this.onParticipantDisconnected = null;
    this.onDataReceived = null;
    this.onLevelUpdate = null;
    this.onConnectionStateChange = null;
    this.onHealthChange = null;

    this._initPTTListener();
    this._startHealthCheck();
    this._initDataListener();
  }

  addTrackSubscribedListener(callback) {
    this._trackSubscribedListeners.add(callback);
    return () => this._trackSubscribedListeners.delete(callback);
  }

  addTrackUnsubscribedListener(callback) {
    this._trackUnsubscribedListeners.add(callback);
    return () => this._trackUnsubscribedListeners.delete(callback);
  }

  addParticipantConnectedListener(callback) {
    this._participantConnectedListeners.add(callback);
    return () => this._participantConnectedListeners.delete(callback);
  }

  addParticipantDisconnectedListener(callback) {
    this._participantDisconnectedListeners.add(callback);
    return () => this._participantDisconnectedListeners.delete(callback);
  }

  addDataReceivedListener(callback) {
    this._dataReceivedListeners.add(callback);
    return () => this._dataReceivedListeners.delete(callback);
  }

  addLevelUpdateListener(callback) {
    this._levelUpdateListeners.add(callback);
    return () => this._levelUpdateListeners.delete(callback);
  }

  addConnectionStateChangeListener(callback) {
    this._connectionStateChangeListeners.add(callback);
    return () => this._connectionStateChangeListeners.delete(callback);
  }

  addHealthChangeListener(callback) {
    this._healthChangeListeners.add(callback);
    return () => this._healthChangeListeners.delete(callback);
  }

  _emitTrackSubscribed(channelName, track, participant) {
    for (const listener of this._trackSubscribedListeners) {
      try { listener(channelName, track, participant); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onTrackSubscribed) {
      try { this.onTrackSubscribed(channelName, track, participant); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitTrackUnsubscribed(channelName, track, participant) {
    for (const listener of this._trackUnsubscribedListeners) {
      try { listener(channelName, track, participant); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onTrackUnsubscribed) {
      try { this.onTrackUnsubscribed(channelName, track, participant); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitParticipantConnected(channelName, participant) {
    for (const listener of this._participantConnectedListeners) {
      try { listener(channelName, participant); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onParticipantConnected) {
      try { this.onParticipantConnected(channelName, participant); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitParticipantDisconnected(channelName, participant) {
    for (const listener of this._participantDisconnectedListeners) {
      try { listener(channelName, participant); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onParticipantDisconnected) {
      try { this.onParticipantDisconnected(channelName, participant); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitDataReceived(channelName, data, participant) {
    for (const listener of this._dataReceivedListeners) {
      try { listener(channelName, data, participant); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onDataReceived) {
      try { this.onDataReceived(channelName, data, participant); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitLevelUpdate(channelName, level) {
    for (const listener of this._levelUpdateListeners) {
      try { listener(channelName, level); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onLevelUpdate) {
      try { this.onLevelUpdate(channelName, level); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitConnectionStateChange(channelName, state, error) {
    for (const listener of this._connectionStateChangeListeners) {
      try { listener(channelName, state, error); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onConnectionStateChange) {
      try { this.onConnectionStateChange(channelName, state, error); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _emitHealthChange(channelName, health) {
    for (const listener of this._healthChangeListeners) {
      try { listener(channelName, health); } catch (e) { console.warn('[AudioWS] Listener error:', e); }
    }
    if (this.onHealthChange) {
      try { this.onHealthChange(channelName, health); } catch (e) { console.warn('[AudioWS] Legacy callback error:', e); }
    }
  }

  _startHealthCheck() {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(() => {
      this._checkAllConnections();
    }, this.HEALTH_CHECK_INTERVAL);
  }

  _checkAllConnections() {
    const now = Date.now();

    for (const [channelName] of this.connectionHealth) {
      if (!this.rooms.has(channelName)) {
        this.connectionHealth.delete(channelName);
      }
    }

    if (this.rooms.size === 0) {
      this._stopHealthCheck();
      return;
    }

    for (const [channelName, conn] of this.rooms) {
      const health = this.connectionHealth.get(channelName) || {
        lastPing: now,
        connected: true,
        quality: 'good'
      };

      const wsConnected = conn.ws && conn.ws.readyState === WebSocket.OPEN;
      const wasConnected = health.connected;
      const oldQuality = health.quality;

      health.connected = wsConnected;
      health.lastCheck = now;

      if (wsConnected) {
        health.lastPing = now;
        health.quality = 'good';
      } else {
        const disconnectedTime = now - health.lastPing;
        if (disconnectedTime > this.CONNECTION_TIMEOUT) {
          health.quality = 'poor';
        } else if (disconnectedTime > this.HEALTH_CHECK_INTERVAL * 2) {
          health.quality = 'degraded';
        }
      }

      this.connectionHealth.set(channelName, health);

      const stateChanged = wasConnected !== wsConnected;
      const qualityChanged = oldQuality !== health.quality;

      if (stateChanged || qualityChanged) {
        console.log(`[AudioWS] Connection health changed for ${channelName}: connected=${wsConnected}, quality=${health.quality}`);
        this._emitHealthChange(channelName, health);
        if (!wsConnected && stateChanged) {
          this._emitConnectionStateChange(channelName, 'disconnected');
        }
      }
    }
  }

  _stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  isChannelHealthy(channelName, { allowReconnecting = false } = {}) {
    const conn = this.rooms.get(channelName);

    if (!conn) {
      if (allowReconnecting && (this._reconnectTimers.has(channelName) || this.pendingConnections.has(channelName))) {
        return true;
      }
      return false;
    }

    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      if (allowReconnecting && (this._reconnectTimers.has(channelName) || this.pendingConnections.has(channelName))) {
        return true;
      }
      return false;
    }

    const health = this.connectionHealth.get(channelName);
    if (health && health.quality === 'poor') {
      if (allowReconnecting && this._reconnectTimers.has(channelName)) {
        return true;
      }
      return false;
    }

    return true;
  }

  areChannelsHealthy(channelNames, { allowReconnecting = false } = {}) {
    return channelNames.every(name => this.isChannelHealthy(name, { allowReconnecting }));
  }

  isChannelReconnecting(channelName) {
    return this._reconnectTimers.has(channelName) || this.pendingConnections.has(channelName);
  }

  waitForRoom(channelName, timeoutMs = 5000) {
    if (this.rooms.has(channelName)) {
      return Promise.resolve(this.rooms.get(channelName));
    }
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (this.rooms.has(channelName)) {
          clearInterval(checkInterval);
          resolve(this.rooms.get(channelName));
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          reject(new Error(`Timed out waiting for room ${channelName}`));
        }
      }, 100);
    });
  }

  getConnectionStatus() {
    const channels = Array.from(this.rooms.keys());
    if (channels.length === 0) return { status: 'disconnected', healthy: 0, total: 0 };

    let healthy = 0;
    for (const channelName of channels) {
      if (this.isChannelHealthy(channelName)) healthy++;
    }

    return {
      status: healthy === channels.length ? 'connected' :
              healthy > 0 ? 'partial' : 'disconnected',
      healthy,
      total: channels.length,
      channels: channels.map(name => ({
        name,
        healthy: this.isChannelHealthy(name),
        state: this.rooms.has(name) ? 'connected' : 'unknown'
      }))
    };
  }

  setChannelActive(channelName) {
    this.activeChannels.add(channelName);
    this._clearIdleTimer(channelName);
    this._recordActivity(channelName);
    console.log(`[AudioWS] Channel ${channelName} marked active`);
  }

  setChannelInactive(channelName) {
    this.activeChannels.delete(channelName);
    this._startIdleTimer(channelName);
    console.log(`[AudioWS] Channel ${channelName} marked inactive, idle timer started`);
  }

  _recordActivity(channelName) {
    this.channelLastActivity.set(channelName, Date.now());
    if (!this.activeChannels.has(channelName)) {
      this._restartIdleTimer(channelName);
    }
  }

  _startIdleTimer(channelName) {
    this._clearIdleTimer(channelName);

    if (this._dispatcherMode) return;
    if (this.activeChannels.has(channelName)) return;
    if (!this.rooms.has(channelName)) return;

    const timerId = setTimeout(() => {
      if (!this.activeChannels.has(channelName) && this.rooms.has(channelName)) {
        console.log(`[AudioWS] Idle timeout - disconnecting from ${channelName}`);
        this.disconnect(channelName);
      }
    }, this.IDLE_TIMEOUT_MS);

    this.idleTimeoutTimers.set(channelName, timerId);
  }

  _clearIdleTimer(channelName) {
    const timerId = this.idleTimeoutTimers.get(channelName);
    if (timerId) {
      clearTimeout(timerId);
      this.idleTimeoutTimers.delete(channelName);
    }
  }

  _restartIdleTimer(channelName) {
    if (this.activeChannels.has(channelName)) return;
    this._startIdleTimer(channelName);
  }

  setIdleTimeout(ms) {
    this.IDLE_TIMEOUT_MS = ms;
    console.log(`[AudioWS] Idle timeout set to ${ms}ms`);
  }

  setDispatcherMode(enabled) {
    this._dispatcherMode = !!enabled;
    if (this._dispatcherMode) {
      for (const [channelName] of this.idleTimeoutTimers) {
        this._clearIdleTimer(channelName);
      }
    } else {
      for (const [channelName] of this._reconnectTimers) {
        clearTimeout(this._reconnectTimers.get(channelName));
      }
      this._reconnectTimers.clear();
      this._reconnectAttempts.clear();
    }
    console.log(`[AudioWS] Dispatcher mode ${this._dispatcherMode ? 'enabled' : 'disabled'} — idle disconnect ${this._dispatcherMode ? 'disabled' : 'enabled'}`);
  }

  isDispatcherMode() {
    return this._dispatcherMode;
  }

  scheduleDispatcherReconnect(channelName, identity) {
    if (!this._dispatcherMode) return;

    const existingTimer = this._reconnectTimers.get(channelName);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    let attempts = this._reconnectAttempts.get(channelName) || 0;
    if (attempts >= this._RECONNECT_MAX_ATTEMPTS) {
      console.log(`[AudioWS] Dispatcher auto-reconnect: resetting attempt counter for ${channelName} (always-connected mode)`);
      attempts = 0;
      this._reconnectAttempts.set(channelName, 0);
    }

    const baseDelay = this._RECONNECT_BASE_DELAY * Math.pow(2, Math.min(attempts, 5));
    const jitter = Math.random() * 1000;
    const delay = Math.min(baseDelay + jitter, this._RECONNECT_MAX_DELAY);

    console.log(`[AudioWS] Dispatcher auto-reconnect: scheduling ${channelName} in ${Math.round(delay)}ms (attempt ${attempts + 1})`);

    const timer = setTimeout(async () => {
      this._reconnectTimers.delete(channelName);

      if (!this._dispatcherMode) return;
      if (this.rooms.has(channelName)) return;

      this._reconnectAttempts.set(channelName, attempts + 1);

      try {
        await this.connect(channelName, identity);
        console.log(`[AudioWS] Dispatcher auto-reconnect: successfully reconnected to ${channelName}`);
        this._reconnectAttempts.delete(channelName);
      } catch (err) {
        console.error(`[AudioWS] Dispatcher auto-reconnect: failed for ${channelName}:`, err.message);
        this.scheduleDispatcherReconnect(channelName, identity);
      }
    }, delay);

    this._reconnectTimers.set(channelName, timer);
  }

  _initDataListener() {
    this._dataListenerRemover = signalingManager.on('data:message', (data) => {
      const channelName = data.channelId;
      const payload = data.payload || data;
      const participant = { identity: data.from || 'unknown' };
      this._emitDataReceived(channelName, payload, participant);
    });
  }

  _initPTTListener() {
    this.pttListenerRemover = micPTTManager.addStateListener((newState, oldState) => {
      const shouldMute = newState === PTT_STATES.ARMING || newState === PTT_STATES.TRANSMITTING;

      if (shouldMute && !this.pttMuted) {
        console.log('[AudioWS] PTT active - muting all RX audio');
        this.pttMuted = true;
      } else if (!shouldMute && this.pttMuted) {
        console.log('[AudioWS] PTT released - unmuting RX audio');
        this.pttMuted = false;
      }
    });
  }

  _getEffectiveVolume() {
    if (this._autoVolumeBoostActive) {
      return Math.min((this._audioSettings.autoIncreaseVolumeLevel ?? 100) / 100, 2.0);
    }
    const baseVol = (this._audioSettings.incomingVolume ?? 80) / 100;
    let amplifier = 1.0;
    if (this._audioSettings.playbackAmplifierEnabled && this._audioSettings.playbackAmplifierLevel) {
      amplifier = 1.0 + (this._audioSettings.playbackAmplifierLevel / 100);
    }
    return Math.min(baseVol * amplifier, 2.0);
  }

  applyAudioSettings(settings) {
    this._audioSettings = {
      incomingVolume: settings.incomingVolume ?? 80,
      playbackAmplifierEnabled: settings.playbackAmplifierEnabled ?? false,
      playbackAmplifierLevel: settings.playbackAmplifierLevel ?? 50,
      autoIncreaseVolumeEnabled: settings.autoIncreaseVolumeEnabled ?? false,
      autoIncreaseVolumeLevel: settings.autoIncreaseVolumeLevel ?? 100,
    };
    console.log('[AUDIO-REBUILD] applyAudioSettings() stored — playback intentionally disabled during rebuild');
  }

  startSettingsListener() {
    if (this._settingsListener) return;
    this._settingsListener = (e) => {
      if (e.detail) {
        this.applyAudioSettings(e.detail);
      }
    };
    window.addEventListener('settings-changed', this._settingsListener);

    try {
      const stored = localStorage.getItem('app_settings');
      if (stored) {
        this.applyAudioSettings(JSON.parse(stored));
      }
    } catch (e) {
      console.warn('[AudioWS] Failed to load initial audio settings:', e);
    }
  }

  setAutoPlayback(enabled) {
    this.autoPlaybackEnabled = enabled;
    console.log(`[AUDIO-REBUILD] setAutoPlayback(${enabled}) — playback intentionally disabled during rebuild`);
  }

  async prepareConnection() {
    console.log('[AUDIO-REBUILD] prepareConnection() — audio warm-up intentionally disabled during rebuild');
  }

  async connect(channelName, identity) {
    if (this.disconnectPromise) {
      console.log(`[AudioWS] Waiting for disconnect to complete before connecting to ${channelName}`);
      await this.disconnectPromise;
    }

    if (this.rooms.has(channelName)) {
      console.log(`[AudioWS] Already connected to ${channelName}`);
      return this.rooms.get(channelName);
    }

    if (this.pendingConnections.has(channelName)) {
      console.log(`[AudioWS] Awaiting existing connection for ${channelName}`);
      return this.pendingConnections.get(channelName);
    }

    const connectionPromise = this._doConnect(channelName, identity);
    this.pendingConnections.set(channelName, connectionPromise);

    try {
      const conn = await connectionPromise;
      return conn;
    } finally {
      this.pendingConnections.delete(channelName);
    }
  }

  async _doConnect(channelName, identity) {
    const native = isNativeAndroid();
    console.log(`[AudioWS] _doConnect() — channel=${channelName} identity=${identity} path=${native ? 'NATIVE' : 'WEB'}`);

    if (native) {
      return this._doConnectNative(channelName, identity);
    }

    const tTotal = performance.now();

    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/api/audio-ws?channelId=${encodeURIComponent(channelName)}&unitId=${encodeURIComponent(identity)}`;

      const ws = await this._openWebSocket(wsUrl);

      const conn = {
        ws,
        state: 'connected',
        channelName,
        unitId: identity,
        localParticipant: { identity },
      };

      this._setupWsHandlers(ws, channelName, identity, conn);

      this.rooms.set(channelName, conn);

      console.log(`[AudioWS] Connected to ${channelName} (total ${(performance.now() - tTotal).toFixed(1)}ms)`);
      console.log('[AUDIO-REBUILD] Audio playback pipeline intentionally disabled during rebuild — WS connected for signaling only');

      notifyChannelJoin(channelName, identity);
      this._recordActivity(channelName);
      this._emitConnectionStateChange(channelName, 'connected');

      return conn;
    } catch (err) {
      console.error(`[AudioWS] Failed to connect to ${channelName}:`, err);
      this._cleanupChannel(channelName, 'connect-failed');
      this._emitConnectionStateChange(channelName, 'failed', err);
      throw err;
    }
  }

  async _doConnectNative(channelName, identity) {
    try {
      const serverBaseUrl = window.location.origin;
      updateServiceConnectionInfo(serverBaseUrl, identity, channelName, serverBaseUrl, channelName);

      const success = await nativeConnect(serverBaseUrl, '', channelName);
      if (!success) {
        throw new Error('Native connect returned false');
      }

      const nativeConn = this._createNativeConnProxy(channelName, identity);
      this.rooms.set(channelName, nativeConn);

      notifyChannelJoin(channelName, identity);
      this._recordActivity(channelName);
      this._emitConnectionStateChange(channelName, 'connected');

      return nativeConn;
    } catch (err) {
      console.error(`[AudioWS] _doConnectNative() FAILED for ${channelName}:`, err);
      this._cleanupChannel(channelName, 'native-connect-failed');
      this._emitConnectionStateChange(channelName, 'failed', err);
      throw err;
    }
  }

  _createNativeConnProxy(channelName, identity) {
    const self = this;
    const proxy = {
      _isNativeProxy: true,
      _channelName: channelName,
      ws: null,
      state: 'connected',
      localParticipant: { identity },
      disconnect: async () => {
        proxy.state = 'disconnected';
        await nativeDisconnect();
        self._cleanupChannel(channelName, 'native-disconnect');
        self._emitConnectionStateChange(channelName, 'disconnected');
      },
    };
    return proxy;
  }

  _openWebSocket(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';

      const onOpen = () => {
        ws.removeEventListener('error', onError);
        console.log(`[AudioWS] WebSocket OPENED for ${url}`);
        resolve(ws);
      };
      const onError = (evt) => {
        ws.removeEventListener('open', onOpen);
        console.error(`[AudioWS] WebSocket ERROR for ${url}`);
        reject(new Error('WebSocket connection failed'));
      };

      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
  }

  _setupWsHandlers(ws, channelName, identity, conn) {
    conn._lastPong = Date.now();

    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            conn._lastPong = Date.now();
            return;
          }
        } catch (e) {}
        this._handleWsTextMessage(channelName, event.data);
        return;
      }
      this._handleWsBinaryMessage(channelName, event.data);
    });

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch (e) {}

        const sincePong = Date.now() - conn._lastPong;
        if (sincePong > 45000) {
          console.warn(`[AudioWS] No pong from server for ${channelName} in ${Math.round(sincePong / 1000)}s — connection likely dead`);
          ws.close();
        }
      }
    }, 15000);

    conn._pingInterval = pingInterval;

    ws.addEventListener('close', (evt) => {
      console.log(`[AudioWS] WebSocket CLOSED for ${channelName} code=${evt.code} reason=${evt.reason || 'none'}`);
      clearInterval(pingInterval);
      if (this.rooms.get(channelName) === conn) {
        this._cleanupChannel(channelName, 'ws-closed');
        this._emitConnectionStateChange(channelName, 'disconnected');

        if (this._dispatcherMode) {
          console.log(`[AudioWS] Dispatcher mode: auto-reconnecting ${channelName}`);
          this.scheduleDispatcherReconnect(channelName, identity);
        }
      }
    });

    ws.addEventListener('error', (err) => {
      console.error(`[AudioWS] WebSocket ERROR for ${channelName}`);
    });
  }

  _handleWsTextMessage(channelName, data) {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'pong') return;
      if (msg.type === 'connected') {
        console.log(`[AudioWS] Server confirmed connection for ${channelName}`);
      }
    } catch (e) {}
  }

  _handleWsBinaryMessage(channelName, data) {
    const frameCount = (this._rxFrameCounters.get(channelName) || 0) + 1;
    this._rxFrameCounters.set(channelName, frameCount);

    if (frameCount === 1 || frameCount % 500 === 0) {
      console.log(`[AUDIO-REBUILD] Binary audio frame #${frameCount} received on ${channelName} — intentionally discarded during rebuild`);
    }

    this._recordActivity(channelName);
  }

  _cleanupChannel(channelName, reason = 'cleanup') {
    console.log(`[AudioWS] Channel cleanup for ${channelName}, reason=${reason}`);
    const conn = this.rooms.get(channelName);

    if (conn && conn._pingInterval) {
      clearInterval(conn._pingInterval);
    }

    this.rooms.delete(channelName);
    this.channelGainNodes.delete(channelName);
    this.mutedChannels.delete(channelName);
    this.connectionHealth.delete(channelName);
    this._rxFrameCounters.delete(channelName);
    this._prePlaybackBuffers.delete(channelName);

    this._clearIdleTimer(channelName);
    this.activeChannels.delete(channelName);
    this.channelLastActivity.delete(channelName);

    const animationId = this.levelAnimations.get(channelName);
    if (animationId) {
      cancelAnimationFrame(animationId);
      this.levelAnimations.delete(channelName);
    }

    this._playbackNodes.delete(channelName);

    if (this.rooms.size === 0) {
      this._stopHealthCheck();
    }
  }

  getRoom(channelName) {
    return this.rooms.get(channelName);
  }

  getConnectedChannels() {
    return Array.from(this.rooms.keys());
  }

  isConnected(channelName) {
    return this.rooms.has(channelName);
  }

  isChannelBusy() {
    return false;
  }

  areAnyChannelsBusy() {
    return false;
  }

  muteChannel(channelName) {
    this.mutedChannels.add(channelName);
    console.log(`[AUDIO-REBUILD] muteChannel(${channelName}) — playback intentionally disabled during rebuild`);
  }

  unmuteChannel(channelName) {
    this.mutedChannels.delete(channelName);
    console.log(`[AUDIO-REBUILD] unmuteChannel(${channelName}) — playback intentionally disabled during rebuild`);
  }

  muteChannels(channelNames) {
    channelNames.forEach(name => this.muteChannel(name));
  }

  unmuteChannels(channelNames) {
    channelNames.forEach(name => this.unmuteChannel(name));
  }

  sendData(channelName, data) {
    signalingManager.sendChannelData(channelName, data);
  }

  setPrimaryTxChannel(channelName) {
    const conn = this.rooms.get(channelName);
    if (!conn) {
      console.warn(`[AudioWS] Cannot set TX channel ${channelName} - not connected`);
      return false;
    }

    console.log(`[AudioWS] Setting primary TX channel to ${channelName}`);
    micPTTManager.setWsTransport(conn.ws);
    this.primaryTxChannel = channelName;
    return true;
  }

  getPrimaryTxChannel() {
    return this.primaryTxChannel || null;
  }

  async startTransmit() {
    if (!this.primaryTxChannel) {
      console.error('[AudioWS] No primary TX channel set');
      return false;
    }

    const conn = this.rooms.get(this.primaryTxChannel);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      console.error(`[AudioWS] TX channel ${this.primaryTxChannel} not connected`);
      return false;
    }

    micPTTManager.setWsTransport(conn.ws);

    console.log(`[AudioWS] Starting transmission on ${this.primaryTxChannel}`);
    return await micPTTManager.start();
  }

  async stopTransmit() {
    console.log('[AudioWS] Stopping transmission');
    await micPTTManager.stop();
  }

  forceReleaseTransmit() {
    console.log('[AudioWS] Force releasing transmission');
    micPTTManager.forceRelease();
  }

  isTransmitting() {
    return micPTTManager.isTransmitting();
  }

  canStartTransmit() {
    return micPTTManager.canStart() && this.primaryTxChannel && this.isChannelHealthy(this.primaryTxChannel);
  }

  getPttState() {
    return micPTTManager.getState();
  }

  onPttStateChange(callback) {
    return micPTTManager.addStateListener(callback);
  }

  setPttErrorHandler(callback) {
    micPTTManager.onError = callback;
  }

  setPttDisconnectHandler(callback) {
    micPTTManager.onDisconnectDuringTx = callback;
  }

  broadcastData(data) {
    for (const [channelName] of this.rooms) {
      this.sendData(channelName, data);
    }
  }

  async disconnect(channelName) {
    const conn = this.rooms.get(channelName);
    if (!conn) return;

    console.log(`[AudioWS] Disconnecting from ${channelName}`);
    this._cleanupChannel(channelName, 'user-disconnect');

    try {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.close();
      }
      if (conn.disconnect) {
        await conn.disconnect();
      }
    } catch (e) {
      console.warn(`[AudioWS] Disconnect warning for ${channelName}:`, e.message);
    }
  }

  async disconnectAll() {
    if (this.disconnectPromise) {
      console.log('[AudioWS] Disconnect already in progress, awaiting');
      return this.disconnectPromise;
    }

    this.disconnectPromise = this._doDisconnectAll();
    await this.disconnectPromise;
    this.disconnectPromise = null;
  }

  async _doDisconnectAll() {
    console.log('[AudioWS] Disconnecting all channels');

    for (const [channelName, timerId] of this._reconnectTimers) {
      clearTimeout(timerId);
    }
    this._reconnectTimers.clear();
    this._reconnectAttempts.clear();

    for (const [channelName] of this.rooms) {
      const animationId = this.levelAnimations.get(channelName);
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
    }

    const closePromises = Array.from(this.rooms.entries()).map(([channelName, conn]) => {
      this._cleanupChannel(channelName, 'disconnect-all');
      try {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
          conn.ws.close();
        }
        if (conn.disconnect) {
          return conn.disconnect();
        }
      } catch (e) {}
      return Promise.resolve();
    });

    await Promise.allSettled(closePromises);

    this.rooms.clear();
    this.channelGainNodes.clear();
    this.mutedChannels.clear();
    this.levelAnimations.clear();
    this.fallbackAudioElements.clear();
    this.pendingConnections.clear();
    this._playbackNodes.clear();

    if (this._autoVolumeCheckInterval) {
      clearInterval(this._autoVolumeCheckInterval);
      this._autoVolumeCheckInterval = null;
    }
    this._autoVolumeBoostActive = false;

    console.log('[AudioWS] All channels disconnected');
  }
}

export const livekitManager = new LiveKitManager();

if (typeof window !== 'undefined') {
  window.__livekitManager = livekitManager;
}

export default livekitManager;
