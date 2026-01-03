import { io } from 'socket.io-client';

const SIGNALING_EVENTS = {
  CHANNEL_JOIN: 'channel:join',
  CHANNEL_LEAVE: 'channel:leave',
  PTT_START: 'ptt:start',
  PTT_END: 'ptt:end',
  PTT_READY: 'ptt:ready',
  EMERGENCY_START: 'emergency:start',
  EMERGENCY_END: 'emergency:end',
  EMERGENCY_FORCE_CONNECT: 'emergency:force_connect',
  UNIT_STATUS_UPDATE: 'unit:status',
  LOCATION_UPDATE: 'unit:location',
  SYSTEM_STATUS: 'system:status',
  TOKEN_REQUEST: 'token:request',
  TOKEN_RESPONSE: 'token:response',
};

class SignalingManager {
  constructor() {
    this.socket = null;
    this.authenticated = false;
    this.unitId = null;
    this.agencyId = null;
    this.username = null;
    this.isDispatcher = false;
    this.subscribedChannels = new Set();
    this.channelMembers = new Map();
    this.livekitAvailable = true;
    
    this._listeners = {
      channelJoin: new Set(),
      channelLeave: new Set(),
      pttStart: new Set(),
      pttEnd: new Set(),
      pttReady: new Set(),
      pttBusy: new Set(),
      emergencyStart: new Set(),
      emergencyEnd: new Set(),
      'emergency:force_connect': new Set(),
      unitStatus: new Set(),
      locationUpdate: new Set(),
      channelMembers: new Set(),
      systemStatus: new Set(),
      connectionChange: new Set(),
      emergencyAlert: new Set(),
    };
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  connect(options = {}) {
    if (this.socket?.connected) {
      console.log('[Signaling] Already connected');
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const serverUrl = window.location.origin;
      
      this.socket = io(serverUrl, {
        path: '/signaling',
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      this.socket.on('connect', () => {
        console.log('[Signaling] Connected to signaling server');
        this.reconnectAttempts = 0;
        this._emit('connectionChange', { connected: true });
        resolve();
      });

      this.socket.on('disconnect', (reason) => {
        console.log('[Signaling] Disconnected:', reason);
        this.authenticated = false;
        this._emit('connectionChange', { connected: false, reason });
      });

      this.socket.on('connect_error', (error) => {
        console.error('[Signaling] Connection error:', error.message);
        this.reconnectAttempts++;
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
          reject(new Error('Failed to connect to signaling server'));
        }
      });

      this.socket.on('authenticated', (data) => {
        console.log('[Signaling] Authenticated as', data.unitId);
        this.authenticated = true;
        this.livekitAvailable = data.livekitAvailable !== false;
      });

      this.socket.on('error', (error) => {
        console.error('[Signaling] Server error:', error.message);
      });

      this._setupEventHandlers();

      setTimeout(() => {
        if (!this.socket?.connected) {
          reject(new Error('Connection timeout'));
        }
      }, 10000);
    });
  }

  _setupEventHandlers() {
    this.socket.on(SIGNALING_EVENTS.CHANNEL_JOIN, (data) => {
      this._emit('channelJoin', data);
    });

    this.socket.on(SIGNALING_EVENTS.CHANNEL_LEAVE, (data) => {
      this._emit('channelLeave', data);
    });

    this.socket.on(SIGNALING_EVENTS.PTT_START, (data) => {
      this._emit('pttStart', data);
    });

    this.socket.on(SIGNALING_EVENTS.PTT_END, (data) => {
      this._emit('pttEnd', data);
    });

    this.socket.on(SIGNALING_EVENTS.PTT_READY, (data) => {
      this._emit('pttReady', data);
    });

    this.socket.on('ptt:busy', (data) => {
      this._emit('pttBusy', data);
    });

    this.socket.on(SIGNALING_EVENTS.EMERGENCY_START, (data) => {
      this._emit('emergencyStart', data);
    });

    this.socket.on(SIGNALING_EVENTS.EMERGENCY_END, (data) => {
      this._emit('emergencyEnd', data);
    });

    this.socket.on(SIGNALING_EVENTS.EMERGENCY_FORCE_CONNECT, (data) => {
      this._emit('emergency:force_connect', data);
    });

    this.socket.on(SIGNALING_EVENTS.UNIT_STATUS_UPDATE, (data) => {
      this._emit('unitStatus', data);
    });

    this.socket.on(SIGNALING_EVENTS.LOCATION_UPDATE, (data) => {
      this._emit('locationUpdate', data);
    });

    this.socket.on('channel:members', (data) => {
      this.channelMembers.set(data.channelId, data.members);
      this._emit('channelMembers', data);
    });

    this.socket.on(SIGNALING_EVENTS.SYSTEM_STATUS, (data) => {
      this.livekitAvailable = data.livekitAvailable !== false;
      this._emit('systemStatus', data);
    });

    this.socket.on('emergency:alert', (data) => {
      this._emit('emergencyAlert', data);
    });

    this.socket.on('emergency:cleared', (data) => {
      this._emit('emergencyEnd', data);
    });
  }

  authenticate(unitId, username, agencyId = 'default', isDispatcher = false) {
    if (!this.socket?.connected) {
      console.error('[Signaling] Cannot authenticate: not connected');
      return false;
    }

    this.unitId = unitId;
    this.username = username;
    this.agencyId = agencyId;
    this.isDispatcher = isDispatcher;

    this.socket.emit('authenticate', {
      unitId,
      username,
      agencyId,
      isDispatcher,
    });

    return true;
  }

  joinChannel(channelId) {
    if (!this.socket?.connected || !this.authenticated) {
      console.error('[Signaling] Cannot join channel: not connected/authenticated');
      return false;
    }

    this.socket.emit(SIGNALING_EVENTS.CHANNEL_JOIN, { channelId });
    this.subscribedChannels.add(channelId);
    return true;
  }

  leaveChannel(channelId) {
    if (!this.socket?.connected) return false;

    this.socket.emit(SIGNALING_EVENTS.CHANNEL_LEAVE, { channelId });
    this.subscribedChannels.delete(channelId);
    this.channelMembers.delete(channelId);
    return true;
  }

  signalPttStart(channelId) {
    if (!this.socket?.connected || !this.authenticated) {
      console.error('[Signaling] Cannot signal PTT start: not connected/authenticated');
      return false;
    }

    if (!this.livekitAvailable) {
      console.error('[Signaling] Cannot start PTT: LiveKit unavailable');
      return false;
    }

    this.socket.emit(SIGNALING_EVENTS.PTT_START, { channelId });
    return true;
  }

  signalPttEnd(channelId) {
    if (!this.socket?.connected) return false;

    this.socket.emit(SIGNALING_EVENTS.PTT_END, { channelId });
    return true;
  }

  signalEmergencyStart(channelId) {
    if (!this.socket?.connected || !this.authenticated) return false;

    this.socket.emit(SIGNALING_EVENTS.EMERGENCY_START, { channelId });
    return true;
  }

  signalEmergencyEnd(channelId) {
    if (!this.socket?.connected) return false;

    this.socket.emit(SIGNALING_EVENTS.EMERGENCY_END, { channelId });
    return true;
  }

  updateStatus(status) {
    if (!this.socket?.connected) return false;

    this.socket.emit(SIGNALING_EVENTS.UNIT_STATUS_UPDATE, { status });
    return true;
  }

  updateLocation(latitude, longitude, accuracy, heading, speed) {
    if (!this.socket?.connected) return false;

    this.socket.emit(SIGNALING_EVENTS.LOCATION_UPDATE, {
      latitude,
      longitude,
      accuracy,
      heading,
      speed,
    });
    return true;
  }

  getChannelMembers(channelId) {
    return this.channelMembers.get(channelId) || [];
  }

  isLivekitAvailable() {
    return this.livekitAvailable;
  }

  on(event, callback) {
    if (!this._listeners[event]) {
      console.warn(`[Signaling] Unknown event type: ${event}`);
      return () => {};
    }
    this._listeners[event].add(callback);
    return () => this._listeners[event].delete(callback);
  }

  off(event, callback) {
    if (this._listeners[event]) {
      this._listeners[event].delete(callback);
    }
  }

  _emit(event, data) {
    if (!this._listeners[event]) return;
    for (const listener of this._listeners[event]) {
      try {
        listener(data);
      } catch (err) {
        console.error(`[Signaling] Listener error for ${event}:`, err);
      }
    }
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.authenticated = false;
    this.subscribedChannels.clear();
    this.channelMembers.clear();
  }

  isConnected() {
    return this.socket?.connected && this.authenticated;
  }
}

export const signalingManager = new SignalingManager();
export { SIGNALING_EVENTS };
