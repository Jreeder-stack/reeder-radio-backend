import { Server } from 'socket.io';

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

class SignalingService {
  constructor() {
    this.io = null;
    this.channelMembers = new Map();
    this.unitPresence = new Map();
    this.activeTransmissions = new Map();
    this.graceChannels = new Map();
    this.emergencyStates = new Map();
    this.connectionTimes = new Map();
    this.livekitAvailable = true;
    
    this.GRACE_PERIOD_MS = 15000;
    this.EMERGENCY_ROOM_LIFETIME_MS = 60000;
    
    this._eventCallbacks = {
      pttStart: [],
      pttEnd: [],
      emergencyStart: [],
      emergencyEnd: [],
    };
  }

  onPttStart(callback) {
    this._eventCallbacks.pttStart.push(callback);
    return () => {
      const idx = this._eventCallbacks.pttStart.indexOf(callback);
      if (idx > -1) this._eventCallbacks.pttStart.splice(idx, 1);
    };
  }

  onPttEnd(callback) {
    this._eventCallbacks.pttEnd.push(callback);
    return () => {
      const idx = this._eventCallbacks.pttEnd.indexOf(callback);
      if (idx > -1) this._eventCallbacks.pttEnd.splice(idx, 1);
    };
  }

  onEmergencyStart(callback) {
    this._eventCallbacks.emergencyStart.push(callback);
    return () => {
      const idx = this._eventCallbacks.emergencyStart.indexOf(callback);
      if (idx > -1) this._eventCallbacks.emergencyStart.splice(idx, 1);
    };
  }

  onEmergencyEnd(callback) {
    this._eventCallbacks.emergencyEnd.push(callback);
    return () => {
      const idx = this._eventCallbacks.emergencyEnd.indexOf(callback);
      if (idx > -1) this._eventCallbacks.emergencyEnd.splice(idx, 1);
    };
  }

  _emitCallback(event, data) {
    const callbacks = this._eventCallbacks[event];
    if (callbacks) {
      callbacks.forEach(cb => {
        try { cb(data); } catch (err) { console.error(`[Signaling] Callback error:`, err); }
      });
    }
  }

  initialize(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: true,
        credentials: true,
      },
      path: '/signaling',
    });

    this.io.on('connection', (socket) => {
      console.log(`[Signaling] Client connected: ${socket.id}`);
      
      socket.on('authenticate', (data) => this._handleAuthenticate(socket, data));
      socket.on(SIGNALING_EVENTS.CHANNEL_JOIN, (data) => this._handleChannelJoin(socket, data));
      socket.on(SIGNALING_EVENTS.CHANNEL_LEAVE, (data) => this._handleChannelLeave(socket, data));
      socket.on(SIGNALING_EVENTS.PTT_START, (data) => this._handlePttStart(socket, data));
      socket.on(SIGNALING_EVENTS.PTT_END, (data) => this._handlePttEnd(socket, data));
      socket.on(SIGNALING_EVENTS.EMERGENCY_START, (data) => this._handleEmergencyStart(socket, data));
      socket.on(SIGNALING_EVENTS.EMERGENCY_END, (data) => this._handleEmergencyEnd(socket, data));
      socket.on(SIGNALING_EVENTS.UNIT_STATUS_UPDATE, (data) => this._handleStatusUpdate(socket, data));
      socket.on(SIGNALING_EVENTS.LOCATION_UPDATE, (data) => this._handleLocationUpdate(socket, data));
      socket.on(SIGNALING_EVENTS.TOKEN_REQUEST, (data) => this._handleTokenRequest(socket, data));
      socket.on('ping', () => socket.emit('pong'));
      socket.on('disconnect', () => this._handleDisconnect(socket));
    });

    console.log('[Signaling] Socket.IO signaling server initialized');
    return this.io;
  }

  _handleAuthenticate(socket, data) {
    const { unitId, agencyId, username, isDispatcher } = data;
    
    if (!unitId || !username) {
      socket.emit('error', { message: 'unitId and username required' });
      return;
    }
    
    socket.unitId = unitId;
    socket.agencyId = agencyId || 'default';
    socket.username = username;
    socket.isDispatcher = isDispatcher || false;
    socket.channels = new Set();
    
    this.unitPresence.set(unitId, {
      socketId: socket.id,
      unitId,
      agencyId: socket.agencyId,
      username,
      isDispatcher,
      status: 'online',
      channels: [],
      lastSeen: Date.now(),
      location: null,
    });
    
    socket.emit('authenticated', { 
      unitId, 
      timestamp: Date.now(),
      livekitAvailable: this.livekitAvailable,
    });
    
    console.log(`[Signaling] Unit authenticated: ${unitId} (${username})`);
  }

  _handleChannelJoin(socket, data) {
    const { channelId } = data;
    
    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    
    socket.join(`channel:${channelId}`);
    socket.channels.add(channelId);
    
    if (!this.channelMembers.has(channelId)) {
      this.channelMembers.set(channelId, new Set());
    }
    this.channelMembers.get(channelId).add(socket.unitId);
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.channels = Array.from(socket.channels);
    }
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.CHANNEL_JOIN, {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
      isDispatcher: socket.isDispatcher,
    });
    
    socket.emit('channel:members', {
      channelId,
      members: this._getChannelMemberDetails(channelId),
    });
    
    const activeTransmission = this.activeTransmissions.get(channelId);
    if (activeTransmission) {
      socket.emit(SIGNALING_EVENTS.PTT_START, activeTransmission);
    }
    
    const emergencyState = this.emergencyStates.get(channelId);
    if (emergencyState) {
      socket.emit(SIGNALING_EVENTS.EMERGENCY_START, emergencyState);
    }
    
    console.log(`[Signaling] ${socket.unitId} joined channel ${channelId}`);
  }

  _handleChannelLeave(socket, data) {
    const { channelId } = data;
    
    if (!socket.unitId) return;
    
    socket.leave(`channel:${channelId}`);
    socket.channels.delete(channelId);
    
    const members = this.channelMembers.get(channelId);
    if (members) {
      members.delete(socket.unitId);
      if (members.size === 0) {
        this.channelMembers.delete(channelId);
      }
    }
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.channels = Array.from(socket.channels);
    }
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.CHANNEL_LEAVE, {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
    });
    
    console.log(`[Signaling] ${socket.unitId} left channel ${channelId}`);
  }

  _handlePttStart(socket, data) {
    const { channelId } = data;
    
    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    
    if (!this.livekitAvailable) {
      socket.emit('error', { message: 'Voice service unavailable', code: 'LIVEKIT_UNAVAILABLE' });
      return;
    }
    
    const existingTransmission = this.activeTransmissions.get(channelId);
    if (existingTransmission && existingTransmission.unitId !== socket.unitId) {
      socket.emit('ptt:busy', { 
        channelId, 
        transmittingUnit: existingTransmission.unitId,
      });
      return;
    }
    
    const graceState = this.graceChannels.get(channelId);
    if (graceState && graceState.unitId !== socket.unitId) {
      socket.emit('ptt:busy', { 
        channelId, 
        transmittingUnit: graceState.unitId,
        inGracePeriod: true,
      });
      return;
    }
    
    if (graceState && graceState.unitId === socket.unitId) {
      this.graceChannels.delete(channelId);
    }
    
    const transmissionData = {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
      isEmergency: this.emergencyStates.has(channelId),
    };
    
    this.activeTransmissions.set(channelId, transmissionData);
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.status = 'transmitting';
    }
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_START, transmissionData);
    
    this._emitCallback('pttStart', transmissionData);
    
    console.log(`[Signaling] PTT START: ${socket.unitId} on ${channelId}`);
  }

  _handlePttEnd(socket, data) {
    const { channelId } = data;
    
    if (!socket.unitId) return;
    
    const transmission = this.activeTransmissions.get(channelId);
    if (!transmission || transmission.unitId !== socket.unitId) {
      return;
    }
    
    const endData = {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
      duration: Date.now() - transmission.timestamp,
      gracePeriodMs: this.GRACE_PERIOD_MS,
    };
    
    this.activeTransmissions.delete(channelId);
    
    this.graceChannels.set(channelId, {
      unitId: socket.unitId,
      expiresAt: Date.now() + this.GRACE_PERIOD_MS,
    });
    
    setTimeout(() => {
      const grace = this.graceChannels.get(channelId);
      if (grace && grace.unitId === socket.unitId) {
        this.graceChannels.delete(channelId);
        console.log(`[Signaling] Grace period ended for ${channelId}`);
      }
    }, this.GRACE_PERIOD_MS);
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.status = 'online';
    }
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_END, endData);
    
    this._emitCallback('pttEnd', endData);
    
    console.log(`[Signaling] PTT END: ${socket.unitId} on ${channelId} (${endData.duration}ms)`);
  }

  _handleEmergencyStart(socket, data) {
    const { channelId } = data;
    
    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    
    const emergencyData = {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
      expiresAt: Date.now() + this.EMERGENCY_ROOM_LIFETIME_MS,
    };
    
    this.emergencyStates.set(channelId, emergencyData);
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.status = 'emergency';
    }
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.EMERGENCY_START, emergencyData);
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.EMERGENCY_FORCE_CONNECT, {
      channelId,
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      timestamp: Date.now(),
      roomLifetimeMs: this.EMERGENCY_ROOM_LIFETIME_MS,
      bypassGracePeriod: true,
      priority: 'emergency',
    });
    
    this._emitCallback('emergencyStart', emergencyData);
    
    this.io.emit('emergency:alert', {
      ...emergencyData,
      message: `EMERGENCY: Unit ${socket.unitId} activated emergency on ${channelId}`,
    });
    
    console.log(`[Signaling] EMERGENCY START: ${socket.unitId} on ${channelId} - Force connect broadcast sent`);
  }

  _handleEmergencyEnd(socket, data) {
    const { channelId, acknowledgedBy } = data;
    
    const emergency = this.emergencyStates.get(channelId);
    if (!emergency) return;
    
    if (socket.unitId !== emergency.unitId && !socket.isDispatcher) {
      socket.emit('error', { message: 'Only the unit or dispatcher can clear emergency' });
      return;
    }
    
    this.emergencyStates.delete(channelId);
    
    const presence = this.unitPresence.get(emergency.unitId);
    if (presence) {
      presence.status = 'online';
    }
    
    const endData = {
      unitId: emergency.unitId,
      agencyId: emergency.agencyId,
      channelId,
      timestamp: Date.now(),
      clearedBy: socket.unitId,
      duration: Date.now() - emergency.timestamp,
    };
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.EMERGENCY_END, endData);
    this._emitCallback('emergencyEnd', endData);
    this.io.emit('emergency:cleared', endData);
    
    console.log(`[Signaling] EMERGENCY END: ${channelId} cleared by ${socket.unitId}`);
  }

  _handleStatusUpdate(socket, data) {
    const { status } = data;
    
    if (!socket.unitId) return;
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.status = status;
      presence.lastSeen = Date.now();
    }
    
    for (const channelId of socket.channels) {
      this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.UNIT_STATUS_UPDATE, {
        unitId: socket.unitId,
        agencyId: socket.agencyId,
        channelId,
        status,
        timestamp: Date.now(),
      });
    }
  }

  _handleLocationUpdate(socket, data) {
    const { latitude, longitude, accuracy, heading, speed } = data;
    
    if (!socket.unitId) return;
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.location = { latitude, longitude, accuracy, heading, speed };
      presence.lastSeen = Date.now();
    }
    
    for (const channelId of socket.channels) {
      this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.LOCATION_UPDATE, {
        unitId: socket.unitId,
        agencyId: socket.agencyId,
        channelId,
        latitude,
        longitude,
        accuracy,
        heading,
        speed,
        timestamp: Date.now(),
      });
    }
  }

  _handleTokenRequest(socket, data) {
    socket.emit(SIGNALING_EVENTS.TOKEN_RESPONSE, {
      requestId: data.requestId,
      shouldFetch: true,
      channelId: data.channelId,
    });
  }

  _handleDisconnect(socket) {
    if (!socket.unitId) {
      console.log(`[Signaling] Anonymous client disconnected: ${socket.id}`);
      return;
    }
    
    for (const channelId of socket.channels || []) {
      const members = this.channelMembers.get(channelId);
      if (members) {
        members.delete(socket.unitId);
        if (members.size === 0) {
          this.channelMembers.delete(channelId);
        }
      }
      
      this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.CHANNEL_LEAVE, {
        unitId: socket.unitId,
        agencyId: socket.agencyId,
        channelId,
        timestamp: Date.now(),
        reason: 'disconnect',
      });
      
      const transmission = this.activeTransmissions.get(channelId);
      if (transmission && transmission.unitId === socket.unitId) {
        this.activeTransmissions.delete(channelId);
        this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_END, {
          unitId: socket.unitId,
          channelId,
          timestamp: Date.now(),
          reason: 'disconnect',
        });
      }
    }
    
    this.unitPresence.delete(socket.unitId);
    console.log(`[Signaling] Unit disconnected: ${socket.unitId}`);
  }

  _getChannelMemberDetails(channelId) {
    const members = this.channelMembers.get(channelId);
    if (!members) return [];
    
    return Array.from(members).map(unitId => {
      const presence = this.unitPresence.get(unitId);
      return presence ? {
        unitId: presence.unitId,
        username: presence.username,
        status: presence.status,
        isDispatcher: presence.isDispatcher,
      } : null;
    }).filter(Boolean);
  }

  notifyAiDispatcher(channelId, event, data) {
    this.io?.emit(`ai:${event}`, { channelId, ...data, timestamp: Date.now() });
  }

  sendPttReady(channelId, targetUnitId) {
    if (!this.io) return;
    
    const readyData = {
      channelId,
      unitId: targetUnitId,
      timestamp: Date.now(),
    };
    
    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_READY, readyData);
    console.log(`[Signaling] PTT_READY sent for ${targetUnitId} on ${channelId}`);
  }

  getChannelMembers(channelId) {
    return this.channelMembers.get(channelId) || new Set();
  }

  getActiveTransmission(channelId) {
    return this.activeTransmissions.get(channelId);
  }

  isEmergencyActive(channelId) {
    return this.emergencyStates.has(channelId);
  }

  getUnitPresence(unitId) {
    return this.unitPresence.get(unitId);
  }

  getAllPresence() {
    return Array.from(this.unitPresence.values());
  }

  setLivekitAvailability(available) {
    this.livekitAvailable = available;
    this.io?.emit(SIGNALING_EVENTS.SYSTEM_STATUS, {
      livekitAvailable: available,
      timestamp: Date.now(),
    });
  }

  recordConnectionTime(unitId, channelId, durationMs) {
    const key = `${unitId}:${channelId}`;
    const existing = this.connectionTimes.get(key) || { total: 0, count: 0 };
    existing.total += durationMs;
    existing.count += 1;
    existing.lastConnection = Date.now();
    this.connectionTimes.set(key, existing);
    console.log(`[Signaling] Connection time recorded: ${unitId} on ${channelId} = ${durationMs}ms (total: ${existing.total}ms)`);
  }

  getConnectionStats(unitId) {
    const stats = [];
    for (const [key, data] of this.connectionTimes) {
      if (key.startsWith(`${unitId}:`)) {
        const channelId = key.split(':')[1];
        stats.push({
          channelId,
          totalMs: data.total,
          connectionCount: data.count,
          lastConnection: data.lastConnection,
        });
      }
    }
    return stats;
  }

  getAllConnectionStats() {
    const stats = [];
    for (const [key, data] of this.connectionTimes) {
      const [unitId, channelId] = key.split(':');
      stats.push({
        unitId,
        channelId,
        totalMs: data.total,
        connectionCount: data.count,
        lastConnection: data.lastConnection,
        avgConnectionMs: Math.round(data.total / data.count),
      });
    }
    return stats;
  }

  getSystemHealth() {
    return {
      signalingConnected: this.io?.engine?.clientsCount > 0,
      livekitAvailable: this.livekitAvailable,
      activeTransmissions: this.activeTransmissions.size,
      activeEmergencies: this.emergencyStates.size,
      connectedUnits: this.unitPresence.size,
      channelCount: this.channelMembers.size,
      timestamp: Date.now(),
    };
  }

  isLivekitAllowed() {
    return this.livekitAvailable && this.io?.engine?.clientsCount > 0;
  }
}

export const signalingService = new SignalingService();
export { SIGNALING_EVENTS };
