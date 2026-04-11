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
  CLEAR_AIR_START: 'clear_air:start',
  CLEAR_AIR_END: 'clear_air:end',
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
    this._connected = false;
    this.unitId = null;
    this.agencyId = null;
    this.username = null;
    this.isDispatcher = false;
    this.subscribedChannels = new Set();
    this.channelMembers = new Map();
    this._keepaliveInterval = null;
    this._pongTimeout = null;

    this._connectPromise = null;
    this._authPromise = null;
    this._joinPromises = new Map();

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
      clearAirStart: new Set(),
      clearAirEnd: new Set(),
      'clear_air:alert': new Set(),
      'clear_air:cleared': new Set(),
      unitStatus: new Set(),
      locationUpdate: new Set(),
      'location:track_start': new Set(),
      'location:track_stop': new Set(),
      'location:update': new Set(),
      channelMembers: new Set(),
      systemStatus: new Set(),
      connectionChange: new Set(),
      emergencyAlert: new Set(),
      'data:message': new Set(),
    };
    
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 999;
  }

  connect(options = {}) {
    if (this.socket?.connected && this._connected) {
      console.log('[Signaling] Already connected');
      return Promise.resolve();
    }

    if (this._connectPromise) {
      console.log('[Signaling] Connection already in progress, returning existing promise');
      return this._connectPromise;
    }

    this._connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const serverUrl = window.location.origin;

      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.disconnect();
        this.socket = null;
      }
      
      this.socket = io(serverUrl, {
        path: '/signaling',
        withCredentials: true,
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: this.maxReconnectAttempts,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      });

      const connectionTimeout = setTimeout(() => {
        if (!settled && !this.socket?.connected) {
          settled = true;
          this._connectPromise = null;
          reject(new Error('Connection timeout'));
        }
      }, 10000);

      this.socket.on('connect', () => {
        clearTimeout(connectionTimeout);
        console.log('[Signaling] Connected to signaling server');
        this._connected = true;
        this.reconnectAttempts = 0;
        this._emit('connectionChange', { connected: true });

        if (this.unitId && !this.authenticated) {
          console.log('[Signaling] Re-authenticating as', this.unitId);
          this._authPromise = null;
          this.authenticate(this.unitId, this.username, this.agencyId, this.isDispatcher)
            .catch(err => console.error('[Signaling] Auto re-auth failed:', err.message));
        }

        this._startKeepalive();

        if (!settled) {
          settled = true;
          this._connectPromise = null;
          resolve();
        }
      });

      this.socket.on('disconnect', (reason) => {
        console.log('[Signaling] Disconnected:', reason);
        this._connected = false;
        this.authenticated = false;
        this._connectPromise = null;

        if (this._authReject) {
          this._authReject(new Error('Disconnected during authentication'));
        }
        this._authPromise = null;
        this._authResolve = null;
        this._authReject = null;
        this._joinPromises.clear();
        this._stopKeepalive();
        this._emit('connectionChange', { connected: false, reason });
      });

      this.socket.on('connect_error', (error) => {
        console.error('[Signaling] Connection error:', error.message);
        this.reconnectAttempts++;
        if (!settled && this.reconnectAttempts >= this.maxReconnectAttempts) {
          settled = true;
          clearTimeout(connectionTimeout);
          this._connectPromise = null;
          reject(new Error('Failed to connect to signaling server'));
        }
      });

      this.socket.on('authenticated', (data) => {
        console.log('[Signaling] Authenticated as', data.unitId);
        this.authenticated = true;

        if (this._authResolve) {
          this._authResolve(data);
          this._authResolve = null;
          this._authReject = null;
        }
        this._authPromise = null;

        if (this.subscribedChannels.size > 0) {
          console.log('[Signaling] Re-joining', this.subscribedChannels.size, 'channels');
          for (const channelId of this.subscribedChannels) {
            this.socket.emit(SIGNALING_EVENTS.CHANNEL_JOIN, { channelId });
          }
        }
      });

      this.socket.on('error', (error) => {
        console.error('[Signaling] Server error:', error.message);
      });

      this._setupEventHandlers();
    });

    return this._connectPromise;
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
      this._emit('systemStatus', data);
    });

    this.socket.on('emergency:alert', (data) => {
      this._emit('emergencyAlert', data);
    });

    this.socket.on('emergency:cleared', (data) => {
      this._emit('emergencyEnd', data);
    });

    this.socket.on(SIGNALING_EVENTS.CLEAR_AIR_START, (data) => {
      this._emit('clearAirStart', data);
    });

    this.socket.on(SIGNALING_EVENTS.CLEAR_AIR_END, (data) => {
      this._emit('clearAirEnd', data);
    });

    this.socket.on('clear_air:alert', (data) => {
      this._emit('clear_air:alert', data);
    });

    this.socket.on('clear_air:cleared', (data) => {
      this._emit('clear_air:cleared', data);
      this._emit('clearAirEnd', data);
    });

    this.socket.on('data:message', (data) => {
      this._emit('data:message', data);
    });

    this.socket.on('location:track_start', (data) => {
      this._emit('location:track_start', data);
    });

    this.socket.on('location:track_stop', (data) => {
      this._emit('location:track_stop', data);
    });

    this.socket.on('location:update', (data) => {
      this._emit('location:update', data);
    });
  }

  async authenticate(unitId, username, agencyId = 'default', isDispatcher = false) {
    this.unitId = unitId;
    this.username = username;
    this.agencyId = agencyId;
    this.isDispatcher = isDispatcher;

    if (this.authenticated) {
      console.log('[Signaling] Already authenticated');
      return true;
    }

    if (this._authPromise) {
      console.log('[Signaling] Authentication already in progress, returning existing promise');
      return this._authPromise;
    }

    if (!this.socket?.connected) {
      console.log('[Signaling] Not connected, waiting for connection before authenticating');
      await this.connect();
    }

    this._authPromise = new Promise((resolve, reject) => {
      this._authResolve = resolve;
      this._authReject = reject;

      const authTimeout = setTimeout(() => {
        if (!this.authenticated) {
          this._authPromise = null;
          this._authResolve = null;
          this._authReject = null;
          reject(new Error('Authentication timeout'));
        }
      }, 10000);

      const originalResolve = this._authResolve;
      this._authResolve = (data) => {
        clearTimeout(authTimeout);
        originalResolve(data);
      };

      const originalReject = this._authReject;
      this._authReject = (err) => {
        clearTimeout(authTimeout);
        originalReject(err);
      };

      this.socket.emit('authenticate', {
        unitId,
        username,
        agencyId,
        isDispatcher,
      });

      console.log('[Signaling] Authentication request sent for', unitId);
    });

    try {
      await this._authPromise;
      return true;
    } catch (err) {
      this._authPromise = null;
      throw err;
    }
  }

  async joinChannel(channelId) {
    if (this.subscribedChannels.has(channelId) && this.socket?.connected && this.authenticated) {
      return true;
    }

    if (this._joinPromises.has(channelId)) {
      return this._joinPromises.get(channelId);
    }

    const joinOp = (async () => {
      if (!this.authenticated) {
        console.log('[Signaling] Not authenticated, waiting for authentication before joining', channelId);
        if (this.unitId) {
          await this.authenticate(this.unitId, this.username, this.agencyId, this.isDispatcher);
        } else {
          console.error('[Signaling] Cannot join channel: no credentials available');
          return false;
        }
      }

      if (!this.socket?.connected) {
        console.error('[Signaling] Cannot join channel: socket not connected after auth');
        return false;
      }

      this.socket.emit(SIGNALING_EVENTS.CHANNEL_JOIN, { channelId });
      this.subscribedChannels.add(channelId);
      console.log('[Signaling] Joined channel:', channelId);
      return true;
    })();

    this._joinPromises.set(channelId, joinOp);
    try {
      const result = await joinOp;
      return result;
    } finally {
      this._joinPromises.delete(channelId);
    }
  }

  async ensureReady(channelId) {
    await this.connect();
    if (!this.unitId) {
      throw new Error('Cannot ensureReady: no credentials stored. Call authenticate() first.');
    }
    await this.authenticate(this.unitId, this.username, this.agencyId, this.isDispatcher);
    if (channelId) {
      await this.joinChannel(channelId);
    }
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
      return Promise.reject(new Error('Not connected'));
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket.off('ptt:granted', onGranted);
        this.socket.off('ptt:busy', onBusy);
        this.socket.off('disconnect', onDisconnect);
      };

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(value);
      };

      const timeout = setTimeout(() => {
        settle(reject, new Error('PTT grant timeout'));
      }, 3000);

      const onGranted = (data) => {
        if (data.channelId === channelId) {
          settle(resolve, data);
        }
      };

      const onBusy = (data) => {
        if (data.channelId === channelId) {
          settle(reject, new Error(`Channel busy: ${data.transmittingUnit}`));
        }
      };

      const onDisconnect = () => {
        settle(reject, new Error('Socket disconnected during PTT request'));
      };

      this.socket.once('ptt:granted', onGranted);
      this.socket.once('ptt:busy', onBusy);
      this.socket.once('disconnect', onDisconnect);
      this.socket.emit(SIGNALING_EVENTS.PTT_START, { channelId });
    });
  }

  signalPttEnd(channelId) {
    if (!this.socket?.connected || !this.authenticated) {
      console.warn('[Signaling] signalPttEnd: socket disconnected or unauthenticated, queuing retry for', channelId);
      this._queuePttEndRetry(channelId);
      return false;
    }

    this.socket.emit(SIGNALING_EVENTS.PTT_END, { channelId });
    return true;
  }

  _queuePttEndRetry(channelId) {
    if (this._pendingPttEnds) {
      this._pendingPttEnds.add(channelId);
    } else {
      this._pendingPttEnds = new Set([channelId]);
    }

    if (!this._pttEndRetryHandler) {
      this._pttEndRetryHandler = () => {
        if (!this._pendingPttEnds || this._pendingPttEnds.size === 0) return;
        if (!this.socket?.connected || !this.authenticated) return;
        const channels = [...this._pendingPttEnds];
        this._pendingPttEnds.clear();
        for (const ch of channels) {
          console.log('[Signaling] Retrying queued ptt:end for', ch);
          this.socket.emit(SIGNALING_EVENTS.PTT_END, { channelId: ch });
        }
      };
      this.on('connectionChange', (e) => {
        if (e.connected && this._pttEndRetryHandler) {
          setTimeout(() => {
            if (this.authenticated) {
              this._pttEndRetryHandler();
            }
          }, 500);
        }
      });
    }

    setTimeout(() => {
      if (this._pendingPttEnds && this._pendingPttEnds.has(channelId)) {
        if (this.socket?.connected && this.authenticated) {
          console.log('[Signaling] Delayed retry ptt:end for', channelId);
          this.socket.emit(SIGNALING_EVENTS.PTT_END, { channelId });
          this._pendingPttEnds.delete(channelId);
        } else {
          console.warn('[Signaling] ptt:end retry failed, still disconnected/unauthenticated for', channelId);
        }
      }
    }, 3000);
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

  signalClearAirStart(channelId) {
    if (!this.socket?.connected || !this.authenticated) return false;

    this.socket.emit(SIGNALING_EVENTS.CLEAR_AIR_START, { channelId });
    return true;
  }

  signalClearAirEnd(channelId) {
    if (!this.socket?.connected) return false;

    this.socket.emit(SIGNALING_EVENTS.CLEAR_AIR_END, { channelId });
    return true;
  }

  sendChannelData(channelId, payload) {
    if (!this.socket?.connected || !this.authenticated) return false;

    this.socket.emit('data:send', { channelId, payload });
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

  isVoiceAvailable() {
    return true;
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

  _startKeepalive() {
    this._stopKeepalive();

    if (!this._pongHandler) {
      this._pongHandler = () => {
        if (this._pongTimeout) {
          clearTimeout(this._pongTimeout);
          this._pongTimeout = null;
        }
      };
    }

    if (this.socket) {
      this.socket.off('pong', this._pongHandler);
      this.socket.on('pong', this._pongHandler);
    }

    this._keepaliveInterval = setInterval(() => {
      if (!this.socket?.connected) {
        this._stopKeepalive();
        return;
      }
      this.socket.emit('ping');
      this._pongTimeout = setTimeout(() => {
        console.warn('[Signaling] Keepalive pong timeout — forcing reconnect');
        this.socket.disconnect();
      }, 5000);
    }, 30000);
  }

  _stopKeepalive() {
    if (this._keepaliveInterval) {
      clearInterval(this._keepaliveInterval);
      this._keepaliveInterval = null;
    }
    if (this._pongTimeout) {
      clearTimeout(this._pongTimeout);
      this._pongTimeout = null;
    }
  }

  disconnect() {
    this._stopKeepalive();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this._connected = false;
    this.authenticated = false;
    this._connectPromise = null;
    this._authPromise = null;
    this._authResolve = null;
    this._authReject = null;
    this._joinPromises.clear();
    this.subscribedChannels.clear();
    this.channelMembers.clear();
  }

  isConnected() {
    return this.socket?.connected && this.authenticated;
  }

  async verifyConnection() {
    if (this.socket?.connected && this.authenticated) {
      console.log('[Signaling] Connection verified — alive and authenticated');
      return true;
    }

    if (this.socket?.connected && !this.authenticated && this.unitId) {
      console.log('[Signaling] Socket connected but not authenticated — re-authenticating');
      try {
        await this.authenticate(this.unitId, this.username, this.agencyId, this.isDispatcher);
        return true;
      } catch (err) {
        console.error('[Signaling] Re-authentication failed:', err.message);
        return false;
      }
    }

    if (!this.socket?.connected && this.unitId) {
      console.log('[Signaling] Socket disconnected — forcing reconnect');
      try {
        await this.connect();
        return true;
      } catch (err) {
        console.error('[Signaling] Reconnect failed:', err.message);
        return false;
      }
    }

    return false;
  }
}

export const signalingManager = new SignalingManager();

if (typeof window !== 'undefined') {
  window.__signalingManager = signalingManager;
}

export { SIGNALING_EVENTS };
