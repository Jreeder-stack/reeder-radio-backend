import { Room, RoomEvent, Track, DataPacket_Kind } from 'livekit-client';
import { getToken, notifyChannelJoin } from '../utils/api.js';
import { micPTTManager, PTT_STATES } from './MicPTTManager.js';
import { isNativeLiveKitAvailable, nativeConnect, nativeDisconnect, updateServiceConnectionInfo } from '../plugins/nativeLiveKit.js';

const LIVEKIT_URL = import.meta.env.VITE_LIVEKIT_URL;

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || 
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const isNativeAndroid = () => isNativeLiveKitAvailable();

class LiveKitManager {
  constructor() {
    this.rooms = new Map();
    this.audioContext = null;
    this.channelGainNodes = new Map();
    this.levelAnimations = new Map();
    this.mutedChannels = new Set();
    this.audioElements = new WeakMap();
    this.fallbackAudioElements = new Map();
    this.disconnectPromise = null;
    this.pendingConnections = new Map();
    this.autoPlaybackEnabled = true;
    this.pttMuted = false;
    this.pttListenerRemover = null;
    this.primaryTxChannel = null;
    
    // Connection health tracking
    this.connectionHealth = new Map(); // channelName -> { lastPing, connected, quality }
    this.healthCheckInterval = null;
    this.HEALTH_CHECK_INTERVAL = 5000; // Check every 5 seconds
    this.CONNECTION_TIMEOUT = 15000; // Consider stale after 15 seconds
    
    // Idle timeout tracking - disconnect from rooms with no activity
    this.channelLastActivity = new Map(); // channelName -> timestamp
    this.activeChannels = new Set(); // Channels that should stay connected (UI visible/selected)
    this.idleTimeoutTimers = new Map(); // channelName -> timeoutId
    this.IDLE_TIMEOUT_MS = 60000; // Disconnect after 60 seconds of inactivity
    this.idleCheckInterval = null;
    
    // Event listener arrays - allows multiple listeners
    this._trackSubscribedListeners = new Set();
    this._trackUnsubscribedListeners = new Set();
    this._participantConnectedListeners = new Set();
    this._participantDisconnectedListeners = new Set();
    this._dataReceivedListeners = new Set();
    this._levelUpdateListeners = new Set();
    this._connectionStateChangeListeners = new Set();
    this._healthChangeListeners = new Set();
    
    // Legacy single callbacks (deprecated but kept for backwards compatibility)
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
  }
  
  // Event listener registration methods
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
  
  // Internal method to emit events to all listeners
  _emitTrackSubscribed(channelName, track, participant) {
    for (const listener of this._trackSubscribedListeners) {
      try { listener(channelName, track, participant); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onTrackSubscribed) {
      try { this.onTrackSubscribed(channelName, track, participant); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitTrackUnsubscribed(channelName, track, participant) {
    for (const listener of this._trackUnsubscribedListeners) {
      try { listener(channelName, track, participant); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onTrackUnsubscribed) {
      try { this.onTrackUnsubscribed(channelName, track, participant); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitParticipantConnected(channelName, participant) {
    for (const listener of this._participantConnectedListeners) {
      try { listener(channelName, participant); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onParticipantConnected) {
      try { this.onParticipantConnected(channelName, participant); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitParticipantDisconnected(channelName, participant) {
    for (const listener of this._participantDisconnectedListeners) {
      try { listener(channelName, participant); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onParticipantDisconnected) {
      try { this.onParticipantDisconnected(channelName, participant); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitDataReceived(channelName, data, participant) {
    for (const listener of this._dataReceivedListeners) {
      try { listener(channelName, data, participant); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onDataReceived) {
      try { this.onDataReceived(channelName, data, participant); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitLevelUpdate(channelName, level) {
    for (const listener of this._levelUpdateListeners) {
      try { listener(channelName, level); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onLevelUpdate) {
      try { this.onLevelUpdate(channelName, level); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitConnectionStateChange(channelName, state, error) {
    for (const listener of this._connectionStateChangeListeners) {
      try { listener(channelName, state, error); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onConnectionStateChange) {
      try { this.onConnectionStateChange(channelName, state, error); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
    }
  }
  
  _emitHealthChange(channelName, health) {
    for (const listener of this._healthChangeListeners) {
      try { listener(channelName, health); } catch (e) { console.warn('[LiveKit] Listener error:', e); }
    }
    if (this.onHealthChange) {
      try { this.onHealthChange(channelName, health); } catch (e) { console.warn('[LiveKit] Legacy callback error:', e); }
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
    
    // Prune stale health entries for rooms that no longer exist
    for (const [channelName] of this.connectionHealth) {
      if (!this.rooms.has(channelName)) {
        this.connectionHealth.delete(channelName);
      }
    }
    
    // Stop health check if no rooms
    if (this.rooms.size === 0) {
      this._stopHealthCheck();
      return;
    }
    
    for (const [channelName, room] of this.rooms) {
      const health = this.connectionHealth.get(channelName) || { 
        lastPing: now, 
        connected: true, 
        quality: 'good' 
      };
      
      // Check room state
      const roomConnected = room.state === 'connected';
      const wasConnected = health.connected;
      const oldQuality = health.quality;
      
      // Update health status
      health.connected = roomConnected;
      health.lastCheck = now;
      
      if (roomConnected) {
        health.lastPing = now;
        health.quality = 'good';
      } else {
        // Calculate quality based on how long disconnected
        const disconnectedTime = now - health.lastPing;
        if (disconnectedTime > this.CONNECTION_TIMEOUT) {
          health.quality = 'poor';
        } else if (disconnectedTime > this.HEALTH_CHECK_INTERVAL * 2) {
          health.quality = 'degraded';
        }
      }
      
      this.connectionHealth.set(channelName, health);
      
      // Notify if state OR quality changed
      const stateChanged = wasConnected !== roomConnected;
      const qualityChanged = oldQuality !== health.quality;
      
      if (stateChanged || qualityChanged) {
        console.log(`[LiveKit] Connection health changed for ${channelName}: connected=${roomConnected}, quality=${health.quality}`);
        this._emitHealthChange(channelName, health);
        if (!roomConnected && stateChanged) {
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

  // Check if a channel is healthy enough for transmission
  isChannelHealthy(channelName) {
    const room = this.rooms.get(channelName);
    if (!room) return false;
    
    if (room.state !== 'connected') {
      console.log(`[LiveKit] Channel ${channelName} not healthy: room state is ${room.state}`);
      return false;
    }
    
    const health = this.connectionHealth.get(channelName);
    if (health && health.quality === 'poor') {
      console.log(`[LiveKit] Channel ${channelName} not healthy: quality is poor`);
      return false;
    }
    
    return true;
  }

  // Check if any of the given channels are healthy for transmission
  areChannelsHealthy(channelNames) {
    return channelNames.every(name => this.isChannelHealthy(name));
  }

  // Get overall connection status for UI
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
        state: this.rooms.get(name)?.state || 'unknown'
      }))
    };
  }

  // Mark a channel as actively monitored (should stay connected)
  setChannelActive(channelName) {
    this.activeChannels.add(channelName);
    this._clearIdleTimer(channelName);
    this._recordActivity(channelName);
    console.log(`[LiveKit] Channel ${channelName} marked active`);
  }

  // Mark a channel as inactive (can be disconnected after idle timeout)
  setChannelInactive(channelName) {
    this.activeChannels.delete(channelName);
    this._startIdleTimer(channelName);
    console.log(`[LiveKit] Channel ${channelName} marked inactive, idle timer started`);
  }

  // Record activity on a channel (resets idle timer)
  _recordActivity(channelName) {
    this.channelLastActivity.set(channelName, Date.now());
    if (!this.activeChannels.has(channelName)) {
      this._restartIdleTimer(channelName);
    }
  }

  // Start idle timer for a channel
  _startIdleTimer(channelName) {
    this._clearIdleTimer(channelName);
    
    if (this.activeChannels.has(channelName)) return;
    if (!this.rooms.has(channelName)) return;
    
    const timerId = setTimeout(() => {
      if (!this.activeChannels.has(channelName) && this.rooms.has(channelName)) {
        console.log(`[LiveKit] Idle timeout - disconnecting from ${channelName}`);
        this.disconnect(channelName);
      }
    }, this.IDLE_TIMEOUT_MS);
    
    this.idleTimeoutTimers.set(channelName, timerId);
  }

  // Clear idle timer for a channel
  _clearIdleTimer(channelName) {
    const timerId = this.idleTimeoutTimers.get(channelName);
    if (timerId) {
      clearTimeout(timerId);
      this.idleTimeoutTimers.delete(channelName);
    }
  }

  // Restart idle timer (on activity)
  _restartIdleTimer(channelName) {
    if (this.activeChannels.has(channelName)) return;
    this._startIdleTimer(channelName);
  }

  // Set the idle timeout duration
  setIdleTimeout(ms) {
    this.IDLE_TIMEOUT_MS = ms;
    console.log(`[LiveKit] Idle timeout set to ${ms}ms`);
  }

  _initPTTListener() {
    this.pttListenerRemover = micPTTManager.addStateListener((newState, oldState) => {
      const shouldMute = newState === PTT_STATES.ARMING || newState === PTT_STATES.TRANSMITTING;
      
      if (shouldMute && !this.pttMuted) {
        console.log('[LiveKit] PTT active - muting all RX audio');
        this.pttMuted = true;
        this._muteAllForPTT();
      } else if (!shouldMute && this.pttMuted) {
        console.log('[LiveKit] PTT released - unmuting RX audio');
        this.pttMuted = false;
        this._unmuteAllAfterPTT();
      }
    });
  }

  _muteAllForPTT() {
    for (const [channelName, gainNode] of this.channelGainNodes) {
      gainNode.gain.value = 0;
    }
    for (const [channelName, elements] of this.fallbackAudioElements) {
      elements.forEach(el => { el.volume = 0; });
    }
  }

  _unmuteAllAfterPTT() {
    for (const [channelName, gainNode] of this.channelGainNodes) {
      if (!this.mutedChannels.has(channelName)) {
        gainNode.gain.value = 1;
      }
    }
    for (const [channelName, elements] of this.fallbackAudioElements) {
      if (!this.mutedChannels.has(channelName)) {
        elements.forEach(el => { el.muted = false; el.volume = 1; });
      }
    }
  }

  setAutoPlayback(enabled) {
    this.autoPlaybackEnabled = enabled;
    console.log(`[LiveKit] Auto playback ${enabled ? 'enabled' : 'disabled'}`);
    
    if (!enabled) {
      this._muteAllExistingAudio();
    } else if (!this.pttMuted) {
      this._unmuteAllAfterPTT();
    }
  }

  _muteAllExistingAudio() {
    console.log('[LiveKit] Muting all existing audio nodes for radio screen takeover');
    for (const [channelName, gainNode] of this.channelGainNodes) {
      gainNode.gain.value = 0;
    }
    for (const [channelName, elements] of this.fallbackAudioElements) {
      elements.forEach(el => { el.volume = 0; el.muted = true; });
    }
  }

  _getAudioContext() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      console.log(`[LiveKit] Created new AudioContext, state: ${this.audioContext.state}`);
    }
    if (this.audioContext.state === 'suspended') {
      console.log('[LiveKit] AudioContext is suspended, attempting resume...');
      this.audioContext.resume().then(() => {
        console.log(`[LiveKit] AudioContext resumed successfully, state: ${this.audioContext.state}`);
      }).catch(e => console.warn('[LiveKit] AudioContext resume failed:', e));
    }
    return this.audioContext;
  }

  async prepareConnection(url, token) {
    if (this._warmRoom) {
      return;
    }
    const t0 = performance.now();
    try {
      const room = new Room();
      this._warmRoom = room;
      await room.prepareConnection(url || LIVEKIT_URL, token);
      console.log(`[LiveKit] prepareConnection warm-up done in ${(performance.now() - t0).toFixed(1)}ms (token=${!!token})`);
    } catch (err) {
      console.warn('[LiveKit] prepareConnection warm-up failed:', err.message);
      this._warmRoom = null;
    }
  }

  async connect(channelName, identity) {
    if (this.disconnectPromise) {
      console.log(`[LiveKit] Waiting for disconnect to complete before connecting to ${channelName}`);
      await this.disconnectPromise;
    }
    
    if (this.rooms.has(channelName)) {
      console.log(`[LiveKit] Already connected to ${channelName}`);
      return this.rooms.get(channelName);
    }
    
    if (this.pendingConnections.has(channelName)) {
      console.log(`[LiveKit] Awaiting existing connection for ${channelName}`);
      return this.pendingConnections.get(channelName);
    }
    
    const connectionPromise = this._doConnect(channelName, identity);
    this.pendingConnections.set(channelName, connectionPromise);
    
    try {
      const room = await connectionPromise;
      return room;
    } finally {
      this.pendingConnections.delete(channelName);
    }
  }
  
  async _doConnect(channelName, identity) {
    const native = isNativeAndroid();
    console.log(`[PTT-DIAG] [JS] LiveKitManager._doConnect() — channel=${channelName} identity=${identity} path=${native ? 'NATIVE' : 'WEB'}`);

    if (native) {
      return this._doConnectNative(channelName, identity);
    }

    const tTotal = performance.now();

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    this._setupRoomEventHandlers(room, channelName);

    try {
      const tToken = performance.now();
      const { token, url: livekitUrl } = await getToken(identity, channelName);
      console.log(`[LiveKit] Token fetch for ${channelName} took ${(performance.now() - tToken).toFixed(1)}ms`);

      const warmUpReady = !!this._warmRoom;
      console.log(`[LiveKit] Warm-up room available before connect: ${warmUpReady}`);
      if (this._warmRoom) {
        try { this._warmRoom.disconnect(); } catch (_) {}
        this._warmRoom = null;
      }

      const tConnect = performance.now();
      await room.connect(livekitUrl || LIVEKIT_URL, token);
      console.log(`[LiveKit] room.connect() for ${channelName} took ${(performance.now() - tConnect).toFixed(1)}ms`);
      
      this.rooms.set(channelName, room);
      console.log(`[LiveKit] Connected to ${channelName} (total ${(performance.now() - tTotal).toFixed(1)}ms)`);
      
      notifyChannelJoin(channelName, identity);
      
      this._recordActivity(channelName);
      this._emitConnectionStateChange(channelName, 'connected');

      return room;
    } catch (err) {
      console.error(`[LiveKit] Failed to connect to ${channelName}:`, err);
      
      if (this._warmRoom) {
        try { this._warmRoom.disconnect(); } catch (_) {}
        this._warmRoom = null;
      }

      try {
        room.disconnect();
      } catch (disconnectErr) {
        console.warn(`[LiveKit] Cleanup disconnect failed for ${channelName}:`, disconnectErr.message);
      }
      
      this._cleanupChannel(channelName);
      
      this._emitConnectionStateChange(channelName, 'failed', err);
      throw err;
    }
  }

  async _doConnectNative(channelName, identity) {
    console.log(`[PTT-DIAG] [JS] _doConnectNative() — channel=${channelName} identity=${identity}`);

    try {
      console.log('[PTT-DIAG] [JS] _doConnectNative() — fetching token from server');
      const { token, url: livekitUrl } = await getToken(identity, channelName);
      const resolvedUrl = livekitUrl || LIVEKIT_URL;
      console.log('[PTT-DIAG] [JS] _doConnectNative() — token received, livekitUrl=' + resolvedUrl);

      const serverBaseUrl = window.location.origin;
      console.log('[PTT-DIAG] [JS] _doConnectNative() — pre-saving service connection info: server=' + serverBaseUrl + ' unit=' + identity + ' channel=' + channelName + ' lkUrl=' + resolvedUrl);
      updateServiceConnectionInfo(serverBaseUrl, identity, channelName, resolvedUrl, channelName);

      console.log('[PTT-DIAG] [JS] _doConnectNative() — calling NativeLiveKit.connect()');
      const success = await nativeConnect(resolvedUrl, token, channelName);
      console.log('[PTT-DIAG] [JS] _doConnectNative() — NativeLiveKit.connect() result=' + success);
      if (!success) {
        throw new Error('Native LiveKit connect returned false');
      }

      const nativeRoom = this._createNativeRoomProxy(channelName, identity);
      this.rooms.set(channelName, nativeRoom);

      console.log(`[PTT-DIAG] [JS] _doConnectNative() — CONNECTED to ${channelName}`);

      notifyChannelJoin(channelName, identity);
      this._recordActivity(channelName);
      this._emitConnectionStateChange(channelName, 'connected');

      return nativeRoom;
    } catch (err) {
      console.error(`[PTT-DIAG] [JS] _doConnectNative() — FAILED for ${channelName}:`, err);
      this._cleanupChannel(channelName);
      this._emitConnectionStateChange(channelName, 'failed', err);
      throw err;
    }
  }

  _createNativeRoomProxy(channelName, identity) {
    const self = this;
    const proxy = {
      _isNativeProxy: true,
      _channelName: channelName,
      state: 'connected',
      localParticipant: {
        identity: identity,
        publishTrack: async () => {
          console.log('[LiveKit] Native proxy: publishTrack called (handled natively)');
          return { track: { sid: 'native-track' } };
        },
        unpublishTrack: async () => {
          console.log('[LiveKit] Native proxy: unpublishTrack called (handled natively)');
        }
      },
      on: () => {},
      off: () => {},
      disconnect: async () => {
        console.log(`[LiveKit] Native proxy: disconnect ${channelName}`);
        proxy.state = 'disconnected';
        await nativeDisconnect();
        self._cleanupChannel(channelName);
        self._emitConnectionStateChange(channelName, 'disconnected');
      },
      removeAllListeners: () => {},
      participants: new Map(),
      numParticipants: 0
    };
    return proxy;
  }

  _setupRoomEventHandlers(room, channelName) {
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log(`[LiveKit] Track subscribed: ${track.kind} from ${participant.identity} on ${channelName}`);
      
      // Record activity for idle timeout
      this._recordActivity(channelName);
      
      // Skip audio from ourselves - we don't want to hear our own transmission
      if (track.kind === Track.Kind.Audio && participant.identity === room.localParticipant?.identity) {
        console.log(`[LiveKit] Skipping self-audio from ${participant.identity}`);
        return;
      }
      
      if (track.kind === Track.Kind.Audio) {
        this._handleAudioTrack(track, participant, channelName, room);
      }
      
      // Emit to all listeners (new pattern)
      console.log(`[LiveKit] Emitting TrackSubscribed to ${this._trackSubscribedListeners.size} listeners`);
      this._emitTrackSubscribed(channelName, track, participant);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
      console.log(`[LiveKit] Track unsubscribed from ${participant.identity} on ${channelName}`);
      this._handleTrackUnsubscribed(channelName, track, participant);
      
      this._emitTrackUnsubscribed(channelName, track, participant);
    });

    room.on(RoomEvent.ParticipantConnected, (participant) => {
      console.log(`[LiveKit] Participant joined ${channelName}: ${participant.identity}`);
      this._emitParticipantConnected(channelName, participant);
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      console.log(`[LiveKit] Participant left ${channelName}: ${participant.identity}`);
      this._emitParticipantDisconnected(channelName, participant);
    });

    room.on(RoomEvent.DataReceived, (payload, participant, kind) => {
      try {
        const data = JSON.parse(new TextDecoder().decode(payload));
        this._emitDataReceived(channelName, data, participant);
      } catch (e) {
        console.warn('[LiveKit] Failed to parse data message:', e);
      }
    });

    room.on(RoomEvent.Disconnected, () => {
      console.log(`[LiveKit] Disconnected from ${channelName}`);
      this._cleanupChannel(channelName);
      
      this._emitConnectionStateChange(channelName, 'disconnected');
    });
  }

  _handleAudioTrack(track, participant, channelName, room) {
    if (!this.autoPlaybackEnabled) {
      console.log(`[LiveKit] Auto playback disabled - skipping audio attachment for ${participant.identity} on ${channelName}`);
      return;
    }
    
    const ctx = this._getAudioContext();
    const audioElem = track.attach();
    
    const shouldMute = this.mutedChannels.has(channelName) || this.pttMuted;
    
    if (this.pttMuted) {
      console.log(`[LiveKit] Muting incoming audio from ${participant.identity} - PTT active`);
    }
    
    audioElem.play().then(() => {
      console.log(`[LiveKit] Audio element playing for ${participant.identity} on ${channelName}`);
    }).catch(e => {
      console.warn(`[LiveKit] Audio autoplay blocked for ${channelName}:`, e.message);
    });
    
    try {
      const source = ctx.createMediaElementSource(audioElem);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.3;
      
      const gainNode = ctx.createGain();
      gainNode.gain.value = shouldMute ? 0 : 1;
      
      source.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      this.channelGainNodes.set(channelName, gainNode);
      this.audioElements.set(audioElem, { source, track, channelName });
      
      this._startLevelMonitor(channelName, analyser);
      console.log(`[LiveKit] Web Audio chain created for ${channelName}, AudioContext state: ${ctx.state}`);
      
    } catch (err) {
      console.warn('[LiveKit] Using direct audio playback for', channelName);
      audioElem.volume = shouldMute ? 0 : 1;
      
      if (!this.fallbackAudioElements.has(channelName)) {
        this.fallbackAudioElements.set(channelName, new Set());
      }
      this.fallbackAudioElements.get(channelName).add(audioElem);
    }
  }

  _startLevelMonitor(channelName, analyser) {
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    
    const update = () => {
      if (!this.rooms.has(channelName)) return;
      
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      
      this._emitLevelUpdate(channelName, Math.min(100, avg * 1.5));
      
      this.levelAnimations.set(channelName, requestAnimationFrame(update));
    };
    
    update();
  }

  _handleTrackUnsubscribed(channelName, track, participant) {
    const animationId = this.levelAnimations.get(channelName);
    if (animationId) {
      cancelAnimationFrame(animationId);
      this.levelAnimations.delete(channelName);
    }
    
    this._emitLevelUpdate(channelName, 0);
    
    try {
      track.detach().forEach(el => {
        const cached = this.audioElements.get(el);
        if (cached) {
          this.audioElements.delete(el);
        }
        const fallbackSet = this.fallbackAudioElements.get(channelName);
        if (fallbackSet) {
          fallbackSet.delete(el);
          if (fallbackSet.size === 0) {
            this.fallbackAudioElements.delete(channelName);
          }
        }
        el.remove();
      });
    } catch (e) {}
  }

  _cleanupChannel(channelName) {
    this.rooms.delete(channelName);
    this.channelGainNodes.delete(channelName);
    this.mutedChannels.delete(channelName);
    this.fallbackAudioElements.delete(channelName);
    this.connectionHealth.delete(channelName);
    
    // Clean up idle timeout tracking
    this._clearIdleTimer(channelName);
    this.activeChannels.delete(channelName);
    this.channelLastActivity.delete(channelName);
    
    const animationId = this.levelAnimations.get(channelName);
    if (animationId) {
      cancelAnimationFrame(animationId);
      this.levelAnimations.delete(channelName);
    }
    
    // Stop health check if no more rooms
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

  isChannelBusy(channelName) {
    const room = this.rooms.get(channelName);
    if (!room) return false;
    
    for (const [, participant] of room.remoteParticipants) {
      for (const [, pub] of participant.audioTrackPublications) {
        if (pub.track && !pub.isMuted) {
          return true;
        }
      }
    }
    return false;
  }

  areAnyChannelsBusy(channelNames) {
    return channelNames.some(name => this.isChannelBusy(name));
  }

  muteChannel(channelName) {
    this.mutedChannels.add(channelName);
    const gainNode = this.channelGainNodes.get(channelName);
    if (gainNode) {
      gainNode.gain.value = 0;
    }
    const fallbackElements = this.fallbackAudioElements.get(channelName);
    if (fallbackElements) {
      fallbackElements.forEach(el => { el.volume = 0; });
    }
  }

  unmuteChannel(channelName) {
    this.mutedChannels.delete(channelName);
    const gainNode = this.channelGainNodes.get(channelName);
    if (gainNode) {
      gainNode.gain.value = 1;
    }
    const fallbackElements = this.fallbackAudioElements.get(channelName);
    if (fallbackElements) {
      fallbackElements.forEach(el => { el.volume = 1; });
    }
  }

  muteChannels(channelNames) {
    channelNames.forEach(name => this.muteChannel(name));
  }

  unmuteChannels(channelNames) {
    channelNames.forEach(name => this.unmuteChannel(name));
  }

  sendData(channelName, data) {
    const room = this.rooms.get(channelName);
    if (!room || room.state !== 'connected') return;

    try {
      const payload = new TextEncoder().encode(JSON.stringify(data));
      room.localParticipant.publishData(payload, DataPacket_Kind.RELIABLE);
    } catch (err) {
      console.warn(`[LiveKit] Failed to send data to ${channelName}:`, err.message);
    }
  }

  // ========== PTT CAPABILITIES ==========
  
  // Set the primary TX channel for PTT
  setPrimaryTxChannel(channelName) {
    const room = this.rooms.get(channelName);
    if (!room) {
      console.warn(`[LiveKit] Cannot set TX channel ${channelName} - not connected`);
      return false;
    }
    
    console.log(`[LiveKit] Setting primary TX channel to ${channelName}`);
    micPTTManager.setRoom(room);
    this.primaryTxChannel = channelName;
    return true;
  }
  
  getPrimaryTxChannel() {
    return this.primaryTxChannel || null;
  }
  
  // Start PTT transmission on the primary TX channel
  async startTransmit() {
    if (!this.primaryTxChannel) {
      console.error('[LiveKit] No primary TX channel set');
      return false;
    }
    
    const room = this.rooms.get(this.primaryTxChannel);
    if (!room || room.state !== 'connected') {
      console.error(`[LiveKit] TX channel ${this.primaryTxChannel} not connected`);
      return false;
    }
    
    // Ensure MicPTTManager has the correct room
    micPTTManager.setRoom(room);
    
    console.log(`[LiveKit] Starting transmission on ${this.primaryTxChannel}`);
    return await micPTTManager.start();
  }
  
  // Stop PTT transmission
  async stopTransmit() {
    console.log('[LiveKit] Stopping transmission');
    await micPTTManager.stop();
  }
  
  // Force release PTT (emergency stop)
  forceReleaseTransmit() {
    console.log('[LiveKit] Force releasing transmission');
    micPTTManager.forceRelease();
  }
  
  // Check if currently transmitting
  isTransmitting() {
    return micPTTManager.isTransmitting();
  }
  
  // Check if PTT can start
  canStartTransmit() {
    return micPTTManager.canStart() && this.primaryTxChannel && this.isChannelHealthy(this.primaryTxChannel);
  }
  
  // Get current PTT state
  getPttState() {
    return micPTTManager.getState();
  }
  
  // Register callbacks for PTT state changes
  onPttStateChange(callback) {
    return micPTTManager.addStateListener(callback);
  }
  
  // Register callback for PTT errors
  setPttErrorHandler(callback) {
    micPTTManager.onError = callback;
  }
  
  // Register callback for disconnect during transmission
  setPttDisconnectHandler(callback) {
    micPTTManager.onDisconnectDuringTx = callback;
  }

  broadcastData(data) {
    for (const [channelName, room] of this.rooms) {
      if (room.state === 'connected') {
        this.sendData(channelName, data);
      }
    }
  }

  async disconnect(channelName) {
    const room = this.rooms.get(channelName);
    if (!room) return;

    console.log(`[LiveKit] Disconnecting from ${channelName}`);
    this._cleanupChannel(channelName);
    
    try {
      await room.disconnect();
    } catch (e) {
      console.warn(`[LiveKit] Disconnect warning for ${channelName}:`, e.message);
    }
  }

  async disconnectAll() {
    if (this.disconnectPromise) {
      console.log('[LiveKit] Disconnect already in progress, awaiting');
      return this.disconnectPromise;
    }
    
    this.disconnectPromise = this._doDisconnectAll();
    await this.disconnectPromise;
    this.disconnectPromise = null;
  }
  
  async _doDisconnectAll() {
    console.log('[LiveKit] Disconnecting all rooms');
    
    for (const [channelName] of this.rooms) {
      const animationId = this.levelAnimations.get(channelName);
      if (animationId) {
        cancelAnimationFrame(animationId);
      }
    }
    
    const disconnectPromises = Array.from(this.rooms.values()).map(room => {
      try {
        return room.disconnect();
      } catch (e) {
        return Promise.resolve();
      }
    });
    
    await Promise.allSettled(disconnectPromises);
    
    this.rooms.clear();
    this.channelGainNodes.clear();
    this.mutedChannels.clear();
    this.levelAnimations.clear();
    this.fallbackAudioElements.clear();
    this.pendingConnections.clear();
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    
    console.log('[LiveKit] All rooms disconnected');
  }
}

export const livekitManager = new LiveKitManager();
export default livekitManager;
