import { Server } from 'socket.io';
import { floorControlService } from './floorControlService.js';
import { audioRelayService } from './audioRelayService.js';
import { canonicalChannelKey } from './channelKeyUtils.js';
import crypto from 'crypto';
import cookie from 'cookie';
import signature from 'cookie-signature';
import pool, { clearUnitEmergencyByIdentity } from '../db/index.js';
import { config } from '../config/env.js';

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

const RADIO_EVENTS = {
  JOIN_CHANNEL: 'radio:joinChannel',
  CHANNEL_JOINED: 'radio:channelJoined',
  LEAVE_CHANNEL: 'radio:leaveChannel',
  PTT_REQUEST: 'ptt:request',
  PTT_RELEASE: 'ptt:release',
  PTT_GRANTED: 'ptt:granted',
  PTT_DENIED: 'ptt:denied',
  TX_START: 'tx:start',
  TX_STOP: 'tx:stop',
  CHANNEL_BUSY: 'channel:busy',
  CHANNEL_IDLE: 'channel:idle',
};

class SignalingService {
  constructor() {
    this.io = null;
    this.channelMembers = new Map();
    this.unitPresence = new Map();
    this.activeTransmissions = new Map();
    this.graceChannels = new Map();
    this.emergencyStates = new Map();
    this.clearAirStates = new Map();
    this.connectionTimes = new Map();
    this.trackedUnitLocations = new Map();
    this.GRACE_PERIOD_MS = 3000;
    
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
      pingInterval: 25000,
      pingTimeout: 60000,
    });

    this.io.on('connection', (socket) => {
      console.log(`[Signaling] Client connected: ${socket.id}`);
      
      socket.on('authenticate', (data) => this._handleAuthenticate(socket, data));
      socket.on(SIGNALING_EVENTS.CHANNEL_JOIN, (data) => this._handleChannelJoin(socket, data));
      socket.on(SIGNALING_EVENTS.CHANNEL_LEAVE, (data) => this._handleChannelLeave(socket, data));
      socket.on('ptt:pre', (data) => this._handlePttPre(socket, data));
      socket.on(SIGNALING_EVENTS.PTT_START, (data) => this._handlePttStart(socket, data));
      socket.on(SIGNALING_EVENTS.PTT_END, (data) => this._handlePttEnd(socket, data));
      socket.on(SIGNALING_EVENTS.EMERGENCY_START, (data) => this._handleEmergencyStart(socket, data));
      socket.on(SIGNALING_EVENTS.EMERGENCY_END, (data) => this._handleEmergencyEnd(socket, data));
      socket.on(SIGNALING_EVENTS.CLEAR_AIR_START, (data) => this._handleClearAirStart(socket, data));
      socket.on(SIGNALING_EVENTS.CLEAR_AIR_END, (data) => this._handleClearAirEnd(socket, data));
      socket.on(SIGNALING_EVENTS.UNIT_STATUS_UPDATE, (data) => this._handleStatusUpdate(socket, data));
      socket.on(SIGNALING_EVENTS.LOCATION_UPDATE, (data) => this._handleLocationUpdate(socket, data));
      socket.on(SIGNALING_EVENTS.TOKEN_REQUEST, (data) => this._handleTokenRequest(socket, data));
      socket.on('data:send', (data) => this._handleDataSend(socket, data));
      socket.on('location:track_start', (data) => this._handleLocationTrackStart(socket, data));
      socket.on('location:track_stop', (data) => this._handleLocationTrackStop(socket, data));
      socket.on('location:update', (data) => this._handleGpsLocationUpdate(socket, data));
      socket.on(RADIO_EVENTS.JOIN_CHANNEL, (data) => this._handleRadioJoinChannel(socket, data));
      socket.on(RADIO_EVENTS.LEAVE_CHANNEL, (data) => this._handleRadioLeaveChannel(socket, data));
      socket.on(RADIO_EVENTS.PTT_REQUEST, (data) => this._handlePttRequest(socket, data));
      socket.on(RADIO_EVENTS.PTT_RELEASE, (data) => this._handlePttRelease(socket, data));
      socket.on(RADIO_EVENTS.TX_START, (data) => this._handleTxStart(socket, data));
      socket.on(RADIO_EVENTS.TX_STOP, (data) => this._handleTxStop(socket, data));
      socket.on('ping', () => {
        socket.emit('pong');
        if (socket.isRadioClient && socket.channels) {
          for (const ch of socket.channels) {
            audioRelayService.refreshSubscriber(ch, socket.unitId);
          }
        }
      });
      socket.on('disconnect', () => this._handleDisconnect(socket));
    });

    floorControlService.onTimeout((channelId, unitId) => {
      const unitSocket = this._findSocketByUnitId(unitId);
      if (unitSocket && unitSocket.radioSessionToken) {
        audioRelayService.removeSession(unitSocket.radioSessionToken);
        unitSocket.radioSessionToken = null;
        unitSocket.radioSessionChannel = null;
      }

      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.TX_STOP, {
        senderUnitId: unitId,
        channelId,
        timestamp: Date.now(),
        reason: 'timeout',
      });

      this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_END, {
        unitId,
        channelId,
        timestamp: Date.now(),
      });

      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
        channelId,
        timestamp: Date.now(),
      });

      const presenceData = this.unitPresence.get(unitId);
      if (presenceData) {
        presenceData.status = 'online';
      }

      console.log(`[Signaling] Floor timeout: ${unitId} on ${channelId}`);
    });

    audioRelayService.setFloorControlService(floorControlService);

    console.log('[Signaling] Socket.IO signaling server initialized');
    return this.io;
  }

  _checkAuthRateLimit(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxAttempts = 10;

    if (!this._authAttempts) {
      this._authAttempts = new Map();
      this._authCleanupInterval = setInterval(() => {
        const cutoff = Date.now() - windowMs;
        for (const [key, timestamps] of this._authAttempts) {
          const filtered = timestamps.filter(t => t > cutoff);
          if (filtered.length === 0) {
            this._authAttempts.delete(key);
          } else {
            this._authAttempts.set(key, filtered);
          }
        }
      }, 60 * 1000);
      if (this._authCleanupInterval.unref) this._authCleanupInterval.unref();
    }

    const attempts = (this._authAttempts.get(ip) || []).filter(t => t > now - windowMs);
    attempts.push(now);
    this._authAttempts.set(ip, attempts);

    return attempts.length > maxAttempts;
  }

  async _handleAuthenticate(socket, data) {
    const { unitId, agencyId, username, isDispatcher } = data;
    
    if (!unitId || !username) {
      socket.emit('error', { message: 'unitId and username required' });
      return;
    }

    const clientIp = socket.handshake?.address || 'unknown';
    if (this._checkAuthRateLimit(clientIp)) {
      console.warn(`[Signaling] Auth rate limited: ip=${clientIp}`);
      socket.emit('error', { message: 'Too many authentication attempts. Try again later.' });
      return;
    }

    let sessionUser = null;
    try {
      const rawCookies = socket.handshake?.headers?.cookie;
      if (rawCookies) {
        const cookies = cookie.parse(rawCookies);
        let sid = cookies['connect.sid'];
        if (sid) {
          if (sid.startsWith('s:')) {
            sid = signature.unsign(sid.slice(2), config.sessionSecret);
            if (sid === false) sid = null;
          }
          if (sid) {
            const sessResult = await pool.query('SELECT sess FROM session WHERE sid = $1', [sid]);
            if (sessResult.rows.length > 0) {
              const sess = typeof sessResult.rows[0].sess === 'string'
                ? JSON.parse(sessResult.rows[0].sess)
                : sessResult.rows[0].sess;
              sessionUser = sess?.user || null;
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Signaling] Session lookup failed:', err.message);
    }

    let validatedUnitId = unitId;
    let validatedUsername = username;
    let validatedIsDispatcher = isDispatcher || false;

    if (sessionUser) {
      validatedUnitId = sessionUser.unit_id || sessionUser.username || unitId;
      validatedUsername = sessionUser.username || username;
      validatedIsDispatcher = sessionUser.role === 'admin' || sessionUser.role === 'dispatcher' || false;
    }

    socket.unitId = validatedUnitId;
    socket.agencyId = agencyId || 'default';
    socket.username = validatedUsername;
    socket.isDispatcher = validatedIsDispatcher;
    socket.channels = new Set();
    
    this.unitPresence.set(validatedUnitId, {
      socketId: socket.id,
      unitId: validatedUnitId,
      agencyId: socket.agencyId,
      username: validatedUsername,
      isDispatcher: validatedIsDispatcher,
      status: 'online',
      channels: [],
      lastSeen: Date.now(),
      location: null,
    });
    
    socket.emit('authenticated', { 
      unitId: validatedUnitId, 
      timestamp: Date.now(),
      voiceAvailable: true,
    });

    if (this.clearAirStates.size > 0) {
      for (const clearAirData of this.clearAirStates.values()) {
        socket.emit('clear_air:alert', {
          ...clearAirData,
          message: `CLEAR AIR active on ${clearAirData.channelId}`,
        });
      }
    }
    
    console.log(`[Signaling] Unit authenticated: ${validatedUnitId} (${validatedUsername})${sessionUser ? ' [session-verified]' : ' [client-claimed]'}`);
  }

  _handleChannelJoin(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    
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
    
    const clearAirState = this.clearAirStates.get(channelId);
    if (clearAirState) {
      socket.emit(SIGNALING_EVENTS.CLEAR_AIR_START, clearAirState);
    }
    
    console.log(`[Signaling] ${socket.unitId} joined channel ${channelId}`);
  }

  _handleChannelLeave(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    
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

  _handlePttPre(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    if (!socket.unitId) return;
    socket.to(`channel:${channelId}`).emit('ptt:pre', {
      unitId: socket.unitId,
      channelId,
    });
  }

  _handlePttStart(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    
    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
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

    const isEmergency = this.emergencyStates.has(channelId);
    console.log(`[Signaling] PTT START request: unitId=${socket.unitId} channelId=${channelId}`);

    const floorResult = floorControlService.requestFloor(channelId, socket.unitId, {
      isEmergency,
      emergencyStates: this.emergencyStates,
    });

    if (!floorResult.granted) {
      console.log(`[Signaling] PTT DENIED: unitId=${socket.unitId} channelId=${channelId} heldBy=${floorResult.heldBy}`);
      socket.emit('ptt:busy', {
        channelId,
        transmittingUnit: floorResult.heldBy || 'unknown',
      });
      return;
    }
    
    const transmissionData = {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
      isEmergency,
    };
    
    this.activeTransmissions.set(channelId, transmissionData);
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.status = 'transmitting';
    }
    
    socket.emit('ptt:granted', { channelId, unitId: socket.unitId, timestamp: Date.now() });

    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_START, transmissionData);
    
    this._emitCallback('pttStart', transmissionData);
    
    console.log(`[Signaling] PTT START granted: ${socket.unitId} on ${channelId} (floor granted for holdsFloor check)`);
  }

  _handlePttEnd(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    
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
    floorControlService.releaseFloor(channelId, socket.unitId);
    
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
    const channelId = canonicalChannelKey(data.channelId);
    
    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }
    
    const emergencyData = {
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      channelId,
      timestamp: Date.now(),
    };
    
    this.emergencyStates.set(channelId, emergencyData);
    
    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.status = 'emergency';
    }
    
    this._emitToChannelDispatchers(channelId, SIGNALING_EVENTS.EMERGENCY_START, emergencyData);
    
    this._emitToChannelDispatchers(channelId, SIGNALING_EVENTS.EMERGENCY_FORCE_CONNECT, {
      channelId,
      unitId: socket.unitId,
      agencyId: socket.agencyId,
      timestamp: Date.now(),
      bypassGracePeriod: true,
      priority: 'emergency',
    });
    
    this._emitCallback('emergencyStart', emergencyData);
    
    this._emitToDispatchers('emergency:alert', {
      ...emergencyData,
      message: `EMERGENCY: Unit ${socket.unitId} activated emergency on ${channelId}`,
    });

    socket.emit('location:track_start', { requestedBy: 'emergency', emergency: true });
    console.log(`[Signaling] Auto GPS track_start for emergency unit ${socket.unitId}`);
    
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
    
    clearUnitEmergencyByIdentity(emergency.unitId).catch(err => {
      console.error(`[Signaling] Failed to clear DB emergency for ${emergency.unitId}:`, err);
    });
    
    const endData = {
      unitId: emergency.unitId,
      agencyId: emergency.agencyId,
      channelId,
      timestamp: Date.now(),
      clearedBy: socket.unitId,
      duration: Date.now() - emergency.timestamp,
    };
    
    this._emitToChannelDispatchers(channelId, SIGNALING_EVENTS.EMERGENCY_END, endData);
    this._emitCallback('emergencyEnd', endData);
    this._emitToDispatchers('emergency:cleared', endData);

    const emergencyUnitSocket = this._findSocketByUnitId(emergency.unitId);
    if (emergencyUnitSocket) {
      emergencyUnitSocket.emit('location:track_stop', { requestedBy: 'emergency_ack' });
      this.trackedUnitLocations.delete(emergency.unitId);
      console.log(`[Signaling] Auto GPS track_stop for emergency unit ${emergency.unitId}`);
    }
    
    console.log(`[Signaling] EMERGENCY END: ${channelId} cleared by ${socket.unitId}`);
  }

  _handleClearAirStart(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    
    if (!socket.unitId || !socket.isDispatcher) {
      socket.emit('error', { message: 'Only dispatchers can activate Clear Air' });
      return;
    }
    
    const channelNamePart = channelId.includes('__') ? channelId.split('__').slice(1).join('__') : channelId;
    const clearAirData = {
      channelId,
      channelName: channelNamePart,
      dispatcherId: socket.unitId,
      agencyId: socket.agencyId,
      timestamp: Date.now(),
    };
    
    this.clearAirStates.set(channelId, clearAirData);
    
    this._emitToChannelDispatchers(channelId, SIGNALING_EVENTS.CLEAR_AIR_START, clearAirData);
    
    this._emitToDispatchers('clear_air:alert', {
      ...clearAirData,
      message: `CLEAR AIR: Dispatcher ${socket.unitId} activated Clear Air on ${channelId}`,
    });
    
    console.log(`[Signaling] CLEAR AIR START: dispatcher ${socket.unitId} on ${channelId}`);
  }

  _handleClearAirEnd(socket, data) {
    const channelId = canonicalChannelKey(data.channelId);
    
    const clearAir = this.clearAirStates.get(channelId);
    if (!clearAir) return;
    
    if (!socket.isDispatcher && socket.unitId !== clearAir.dispatcherId) {
      socket.emit('error', { message: 'Only the dispatcher can release Clear Air' });
      return;
    }
    
    this.clearAirStates.delete(channelId);
    
    const endData = {
      channelId,
      dispatcherId: clearAir.dispatcherId,
      agencyId: clearAir.agencyId,
      timestamp: Date.now(),
      duration: Date.now() - clearAir.timestamp,
    };
    
    this._emitToChannelDispatchers(channelId, SIGNALING_EVENTS.CLEAR_AIR_END, endData);
    this._emitToDispatchers('clear_air:cleared', endData);
    
    console.log(`[Signaling] CLEAR AIR END: ${channelId} released by ${socket.unitId}`);
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
      this._emitToChannelDispatchers(channelId, SIGNALING_EVENTS.LOCATION_UPDATE, {
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

  _handleLocationTrackStart(socket, data) {
    const { unitId } = data;
    if (!socket.isDispatcher) {
      socket.emit('error', { message: 'Only dispatchers can request tracking' });
      return;
    }
    if (!unitId) return;

    const targetSocket = this._findSocketByUnitId(unitId);
    if (targetSocket) {
      targetSocket.emit('location:track_start', { requestedBy: socket.unitId });
      console.log(`[Signaling] GPS track_start sent to ${unitId} by ${socket.unitId}`);
    }
  }

  _handleLocationTrackStop(socket, data) {
    const { unitId } = data;
    if (!socket.isDispatcher) {
      socket.emit('error', { message: 'Only dispatchers can stop tracking' });
      return;
    }
    if (!unitId) return;

    const targetSocket = this._findSocketByUnitId(unitId);
    if (targetSocket) {
      targetSocket.emit('location:track_stop', { requestedBy: socket.unitId });
      console.log(`[Signaling] GPS track_stop sent to ${unitId} by ${socket.unitId}`);
    }

    this.trackedUnitLocations.delete(unitId);
  }

  _handleGpsLocationUpdate(socket, data) {
    if (!socket.unitId) return;

    const locationEntry = {
      unitId: socket.unitId,
      lat: data.lat,
      lng: data.lng,
      accuracy: data.accuracy,
      heading: data.heading,
      speed: data.speed,
      timestamp: data.timestamp || Date.now(),
    };

    this.trackedUnitLocations.set(socket.unitId, locationEntry);

    try {
      import('../services/locationService.js').then(mod => {
        const locationService = mod.default;
        if (locationService && locationService.updateLocation) {
          locationService.updateLocation(socket.unitId, data.lat, data.lng, data.accuracy);
        }
      }).catch(() => {});
    } catch (e) {}

    if (this.io) {
      this.io.sockets.sockets.forEach((s) => {
        if (s.isDispatcher && s.id !== socket.id) {
          s.emit('location:update', locationEntry);
        }
      });
    }
  }

  _emitToDispatchers(event, data) {
    if (!this.io) return;
    this.io.sockets.sockets.forEach((s) => {
      if (s.isDispatcher) {
        s.emit(event, data);
      }
    });
  }

  _emitToChannelDispatchers(channelId, event, data) {
    if (!this.io) return;
    const room = `channel:${channelId}`;
    this.io.sockets.sockets.forEach((s) => {
      if (s.isDispatcher && s.rooms && s.rooms.has(room)) {
        s.emit(event, data);
      }
    });
  }

  _findSocketByUnitId(unitId) {
    if (!this.io) return null;
    for (const [, s] of this.io.sockets.sockets) {
      if (s.unitId === unitId) return s;
    }
    return null;
  }

  getTrackedLocations() {
    return Array.from(this.trackedUnitLocations.values());
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

      if (floorControlService.holdsFloor(channelId, socket.unitId)) {
        floorControlService.releaseFloor(channelId, socket.unitId);
        this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.TX_STOP, {
          unitId: socket.unitId,
          channelId,
          timestamp: Date.now(),
          reason: 'disconnect',
        });
        this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
          channelId,
          timestamp: Date.now(),
        });
      }

      audioRelayService.removeSubscriber(channelId, socket.unitId);
    }

    for (const [channelId, transmission] of this.activeTransmissions) {
      if (transmission.unitId === socket.unitId && !(socket.channels && socket.channels.has(channelId))) {
        this.activeTransmissions.delete(channelId);
        floorControlService.releaseFloor(channelId, socket.unitId);
        this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_END, {
          unitId: socket.unitId,
          channelId,
          timestamp: Date.now(),
          reason: 'disconnect',
        });
        console.log(`[Signaling] Cleaned up orphaned transmission for ${socket.unitId} on ${channelId}`);
      }
    }

    const releasedChannels = floorControlService.releaseAllForUnit(socket.unitId);
    for (const channelId of releasedChannels) {
      if (!(socket.channels && socket.channels.has(channelId))) {
        this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
          channelId,
          timestamp: Date.now(),
        });
        console.log(`[Signaling] Released orphaned floor for ${socket.unitId} on ${channelId}`);
      }
    }

    if (socket.radioSessionToken) {
      audioRelayService.removeSession(socket.radioSessionToken);
    }
    audioRelayService.removeSessionsByUnit(socket.unitId);
    
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

  _handleDataSend(socket, data) {
    if (!socket.unitId) return;
    const { channelId, payload } = data;
    if (!channelId || !payload) return;

    socket.to(`channel:${channelId}`).emit('data:message', {
      channelId,
      payload,
      from: socket.unitId,
      timestamp: Date.now(),
    });
  }

  broadcastDataToChannel(channelId, data) {
    if (!this.io) return;
    this.io.to(`channel:${channelId}`).emit('data:message', data);
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
      audioTransportAvailable: true,
      activeTransmissions: this.activeTransmissions.size,
      activeEmergencies: this.emergencyStates.size,
      connectedUnits: this.unitPresence.size,
      channelCount: this.channelMembers.size,
      timestamp: Date.now(),
    };
  }

  async _handleRadioJoinChannel(socket, data) {
    const { channelId: rawChannelId, udpPort, udpAddress } = data;
    const channelId = String(rawChannelId);

    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    try {
      const accessResult = await pool.query(
        `SELECT uca.channel_id
         FROM user_channel_access uca
         JOIN users u ON uca.user_id = u.id
         JOIN channels c ON uca.channel_id = c.id
         WHERE (u.unit_id = $1 OR u.username = $1)
           AND (c.id::text = $2 OR COALESCE(c.zone, 'Default') || '__' || c.name = $2)
           AND c.enabled = true
         LIMIT 1`,
        [socket.unitId, channelId]
      );

      if (accessResult.rows.length === 0) {
        socket.emit('error', { message: 'Not authorized for this channel' });
        console.log(`[Signaling] Radio ${socket.unitId} denied access to channel ${channelId}`);
        return;
      }
    } catch (dbErr) {
      console.error('[Signaling] DB channel access check failed:', dbErr.message);
      socket.emit('error', { message: 'Authorization check failed' });
      return;
    }

    socket.join(`channel:${channelId}`);
    if (!socket.channels) socket.channels = new Set();
    socket.channels.add(channelId);
    socket.isRadioClient = true;

    if (!this.channelMembers.has(channelId)) {
      this.channelMembers.set(channelId, new Set());
    }
    this.channelMembers.get(channelId).add(socket.unitId);

    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.channels = Array.from(socket.channels);
    }

    const peerAddressRaw = socket.handshake?.address || '';
    const peerAddress = peerAddressRaw.startsWith('::ffff:') ? peerAddressRaw.slice(7) : peerAddressRaw;
    const subscriberAddress = (udpAddress || peerAddress || '').trim();
    const subscriberPort = Number(udpPort);
    if (subscriberPort > 0 && subscriberAddress) {
      audioRelayService.addSubscriber(channelId, socket.unitId, subscriberAddress, subscriberPort);
      console.log(`[Signaling] SUBSCRIBER_REGISTERED unitId=${socket.unitId} channelId=${channelId} address=${subscriberAddress} port=${subscriberPort}`);
    } else {
      console.warn(`[Signaling] SUBSCRIBER_REGISTRATION_FAILED unitId=${socket.unitId} channelId=${channelId} udpPort=${udpPort ?? 'missing'} udpAddress=${udpAddress ?? 'missing'} peerAddress=${peerAddress || 'missing'}`);
    }

    socket.emit(RADIO_EVENTS.CHANNEL_JOINED, {
      channelId,
      timestamp: Date.now(),
      members: this._getChannelMemberDetails(channelId),
    });

    const floorHolder = floorControlService.getFloorHolder(channelId);
    if (floorHolder) {
      socket.emit(RADIO_EVENTS.CHANNEL_BUSY, {
        channelId,
        heldBy: floorHolder.unitId,
        timestamp: Date.now(),
      });
    }

    console.log(`[Signaling] CHANNEL_JOINED unitId=${socket.unitId} channelId=${channelId}`);

    this._issueRadioSessionToken(socket, channelId, 'join');
  }

  _handleRadioLeaveChannel(socket, data) {
    const channelId = String(data.channelId);

    if (!socket.unitId) return;

    socket.leave(`channel:${channelId}`);
    if (socket.channels) socket.channels.delete(channelId);

    const members = this.channelMembers.get(channelId);
    if (members) {
      members.delete(socket.unitId);
      if (members.size === 0) {
        this.channelMembers.delete(channelId);
      }
    }

    const presence = this.unitPresence.get(socket.unitId);
    if (presence) {
      presence.channels = Array.from(socket.channels || []);
    }

    audioRelayService.removeSubscriber(channelId, socket.unitId);

    if (floorControlService.holdsFloor(channelId, socket.unitId)) {
      floorControlService.releaseFloor(channelId, socket.unitId);
      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.TX_STOP, {
        senderUnitId: socket.unitId,
        channelId,
        timestamp: Date.now(),
        reason: 'leave',
      });
      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
        channelId,
        timestamp: Date.now(),
      });
    }

    socket.emit('radio:channelLeft', { channelId, timestamp: Date.now() });
    console.log(`[Signaling] Radio ${socket.unitId} left channel ${channelId}`);
  }

  _handlePttRequest(socket, data) {
    const channelId = String(data.channelId);

    if (!socket.unitId) {
      socket.emit('error', { message: 'Not authenticated' });
      return;
    }

    if (!socket.channels || !socket.channels.has(channelId)) {
      socket.emit(RADIO_EVENTS.PTT_DENIED, {
        channelId,
        reason: 'not_on_channel',
        timestamp: Date.now(),
      });
      return;
    }

    console.log(`[Signaling] PTT_REQUEST_SENT unitId=${socket.unitId} channelId=${channelId}`);

    const isEmergency = this.emergencyStates.has(channelId) &&
      this.emergencyStates.get(channelId).unitId === socket.unitId;

    const result = floorControlService.requestFloor(channelId, socket.unitId, {
      isEmergency,
      emergencyStates: this.emergencyStates,
    });

    if (result.granted) {
      this._issueRadioSessionToken(socket, channelId, 'ptt_granted');

      socket.emit(RADIO_EVENTS.PTT_GRANTED, {
        channelId,
        senderUnitId: socket.unitId,
        timestamp: Date.now(),
      });
      console.log(`[Signaling] PTT_GRANTED unitId=${socket.unitId} channelId=${channelId}`);

      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.TX_START, {
        senderUnitId: socket.unitId,
        channelId,
        timestamp: Date.now(),
        isEmergency: result.isEmergency || false,
      });

      this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_START, {
        unitId: socket.unitId,
        agencyId: socket.agencyId,
        channelId,
        timestamp: Date.now(),
        isEmergency: isEmergency || false,
      });

      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_BUSY, {
        channelId,
        heldBy: socket.unitId,
        timestamp: Date.now(),
      });

      if (result.preemptedUnit) {
        const preemptedSocket = this._findSocketByUnitId(result.preemptedUnit);
        if (preemptedSocket) {
          preemptedSocket.emit(RADIO_EVENTS.PTT_DENIED, {
            channelId,
            reason: 'preempted_emergency',
            timestamp: Date.now(),
          });
          if (preemptedSocket.radioSessionToken) {
            audioRelayService.removeSession(preemptedSocket.radioSessionToken);
            preemptedSocket.radioSessionToken = null;
            preemptedSocket.radioSessionChannel = null;
          }
        }
      }

      const presenceData = this.unitPresence.get(socket.unitId);
      if (presenceData) {
        presenceData.status = 'transmitting';
      }

      this._emitCallback('pttStart', {
        unitId: socket.unitId,
        channelId,
        timestamp: Date.now(),
        isEmergency: isEmergency || false,
      });

      console.log(`[Signaling] PTT granted: ${socket.unitId} on ${channelId}`);
    } else {
      socket.emit(RADIO_EVENTS.PTT_DENIED, {
        channelId,
        reason: result.reason,
        heldBy: result.heldBy,
        senderUnitId: socket.unitId,
        timestamp: Date.now(),
      });
      console.log(`[Signaling] PTT_DENIED unitId=${socket.unitId} channelId=${channelId} reason=${result.reason} heldBy=${result.heldBy || ''}`);
      console.log(`[Signaling] PTT denied: ${socket.unitId} on ${channelId} (${result.reason})`);
    }
  }

  _issueRadioSessionToken(socket, channelId, reason = 'unknown') {
    if (!socket?.unitId || !channelId) return null;

    console.log(`[Signaling] RADIO_TOKEN_ISSUE_ATTEMPT unitId=${socket.unitId} channelId=${channelId} reason=${reason}`);

    if (socket.radioSessionToken) {
      audioRelayService.removeSession(socket.radioSessionToken);
    }

    const sessionToken = crypto.randomBytes(16).toString('hex');
    socket.radioSessionToken = sessionToken;
    socket.radioSessionChannel = channelId;
    audioRelayService.registerSession(socket.unitId, sessionToken, channelId);
    console.log(`[Signaling] RADIO_TOKEN_ISSUED unitId=${socket.unitId} channelId=${channelId} reason=${reason}`);

    socket.emit('radio:sessionToken', { token: sessionToken, channelId });
    console.log(`[Signaling] RADIO_TOKEN_EMIT channelId=${channelId} roomKey=${channelId} unitId=${socket.unitId}`);
    return sessionToken;
  }

  _handlePttRelease(socket, data) {
    const channelId = String(data.channelId);

    if (!socket.unitId) return;
    console.log(`[Signaling] PTT_RELEASE_SENT unitId=${socket.unitId} channelId=${channelId}`);

    const floorHolder = floorControlService.getFloorHolder(channelId);
    const grantedAt = floorHolder && floorHolder.unitId === socket.unitId ? floorHolder.grantedAt : null;

    const released = floorControlService.releaseFloor(channelId, socket.unitId);
    if (!released) return;

    if (socket.radioSessionToken) {
      audioRelayService.removeSession(socket.radioSessionToken);
      socket.radioSessionToken = null;
      socket.radioSessionChannel = null;
    }

    const presenceData = this.unitPresence.get(socket.unitId);
    if (presenceData) {
      presenceData.status = 'online';
    }

    const now = Date.now();

    this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.TX_STOP, {
      senderUnitId: socket.unitId,
      channelId,
      timestamp: now,
    });

    this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_END, {
      unitId: socket.unitId,
      channelId,
      timestamp: now,
      duration: grantedAt ? now - grantedAt : undefined,
    });

    this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
      channelId,
      timestamp: Date.now(),
    });

    this._emitCallback('pttEnd', {
      unitId: socket.unitId,
      channelId,
      timestamp: Date.now(),
    });

    console.log(`[Signaling] PTT released: ${socket.unitId} on ${channelId}`);
  }

  _handleTxStart(socket, data) {
    const channelId = String(data.channelId);
    if (!socket.unitId) return;

    if (!floorControlService.holdsFloor(channelId, socket.unitId)) {
      socket.emit('error', { message: 'Cannot start TX without floor grant' });
      return;
    }

    for (const ch of socket.channels || []) {
      if (ch === channelId) {
        audioRelayService.refreshSubscriber(ch, socket.unitId);
      }
    }

    console.log(`[Signaling] TX start ack: ${socket.unitId} on ${channelId}`);
  }

  _handleTxStop(socket, data) {
    const channelId = String(data.channelId);
    if (!socket.unitId) return;

    if (floorControlService.holdsFloor(channelId, socket.unitId)) {
      const floorHolder = floorControlService.getFloorHolder(channelId);
      const grantedAt = floorHolder ? floorHolder.grantedAt : null;

      floorControlService.releaseFloor(channelId, socket.unitId);

      if (socket.radioSessionToken) {
        audioRelayService.removeSession(socket.radioSessionToken);
        socket.radioSessionToken = null;
        socket.radioSessionChannel = null;
      }

      const presenceData = this.unitPresence.get(socket.unitId);
      if (presenceData) {
        presenceData.status = 'online';
      }

      const now = Date.now();

      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.TX_STOP, {
        senderUnitId: socket.unitId,
        channelId,
        timestamp: now,
      });

      this.io.to(`channel:${channelId}`).emit(SIGNALING_EVENTS.PTT_END, {
        unitId: socket.unitId,
        channelId,
        timestamp: now,
        duration: grantedAt ? now - grantedAt : undefined,
      });

      this.io.to(`channel:${channelId}`).emit(RADIO_EVENTS.CHANNEL_IDLE, {
        channelId,
        timestamp: Date.now(),
      });
    }

    console.log(`[Signaling] TX stop ack: ${socket.unitId} on ${channelId}`);
  }

  stop() {
    if (this._authCleanupInterval) {
      clearInterval(this._authCleanupInterval);
      this._authCleanupInterval = null;
    }
    if (this.io) {
      this.io.close();
      this.io = null;
      console.log('[Signaling] Socket.IO server closed');
    }
  }
}

export const signalingService = new SignalingService();
export { SIGNALING_EVENTS, RADIO_EVENTS };
