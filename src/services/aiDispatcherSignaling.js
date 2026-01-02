import { signalingService, SIGNALING_EVENTS } from './signalingService.js';

const AI_UNIT_ID = 'AI-Dispatcher';
const CONNECTION_GRACE_MS = 5000;

class AIDispatcherSignaling {
  constructor() {
    this.dispatcher = null;
    this.activeChannels = new Set();
    this.connectionTimers = new Map();
    this.transmissionLogs = [];
    this.initialized = false;
  }

  log(action, details = {}) {
    const timestamp = new Date().toISOString();
    console.log(`[AI-Dispatcher-Signaling] ${timestamp} | ${action}`, JSON.stringify(details));
  }

  initialize(dispatcher) {
    if (this.initialized) return;
    
    this.dispatcher = dispatcher;
    this.initialized = true;
    
    this.log('INITIALIZED', { channels: Array.from(this.activeChannels) });
  }

  setActiveChannel(channelId) {
    this.activeChannels.add(channelId);
    this.log('CHANNEL_ACTIVATED', { channelId });
  }

  removeActiveChannel(channelId) {
    this.activeChannels.delete(channelId);
    this._clearConnectionTimer(channelId);
    this.log('CHANNEL_DEACTIVATED', { channelId });
  }

  async handlePttStart(channelId, unitId, isEmergency = false) {
    if (!this.dispatcher) {
      this.log('PTT_IGNORED', { reason: 'Dispatcher not initialized' });
      return;
    }

    if (!this.activeChannels.has(channelId)) {
      this.log('PTT_IGNORED', { channelId, reason: 'Channel not active' });
      return;
    }

    if (unitId === AI_UNIT_ID) {
      return;
    }

    this._clearConnectionTimer(channelId);

    this.log('PTT_START_DETECTED', { channelId, unitId, isEmergency });

    const transmissionLog = {
      channelId,
      unitId,
      startTime: Date.now(),
      isEmergency,
    };
    this.transmissionLogs.push(transmissionLog);

    if (!this.dispatcher.room) {
      this.log('CONNECTING_FOR_PTT', { channelId, unitId });
      try {
        await this.dispatcher.rejoinIfNeeded();
      } catch (err) {
        this.log('CONNECTION_FAILED', { channelId, error: err.message });
      }
    }
  }

  async handlePttEnd(channelId, unitId, gracePeriodMs = CONNECTION_GRACE_MS) {
    if (!this.dispatcher) return;
    if (!this.activeChannels.has(channelId)) return;
    if (unitId === AI_UNIT_ID) return;

    this.log('PTT_END_DETECTED', { channelId, unitId, gracePeriodMs });

    const log = this.transmissionLogs.find(
      l => l.channelId === channelId && l.unitId === unitId && !l.endTime
    );
    if (log) {
      log.endTime = Date.now();
      log.duration = log.endTime - log.startTime;
    }

    this._startConnectionTimer(channelId, gracePeriodMs);
  }

  async handleEmergencyStart(channelId, unitId) {
    if (!this.dispatcher) return;
    if (!this.activeChannels.has(channelId)) return;

    this.log('EMERGENCY_START_DETECTED', { channelId, unitId });

    this._clearConnectionTimer(channelId);

    if (!this.dispatcher.room) {
      try {
        await this.dispatcher.rejoinIfNeeded();
      } catch (err) {
        this.log('EMERGENCY_CONNECTION_FAILED', { channelId, error: err.message });
      }
    }
  }

  async handleEmergencyEnd(channelId, unitId) {
    if (!this.dispatcher) return;

    this.log('EMERGENCY_END_DETECTED', { channelId, unitId });
  }

  _clearConnectionTimer(channelId) {
    const timer = this.connectionTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.connectionTimers.delete(channelId);
    }
  }

  _startConnectionTimer(channelId, delayMs) {
    this._clearConnectionTimer(channelId);

    const timer = setTimeout(async () => {
      this.connectionTimers.delete(channelId);
      await this._checkAndDisconnect(channelId);
    }, delayMs);

    this.connectionTimers.set(channelId, timer);
  }

  async _checkAndDisconnect(channelId) {
    if (!this.dispatcher || !this.dispatcher.room) return;

    const hasActiveTransmission = signalingService.getActiveTransmission(channelId);
    const isEmergency = signalingService.isEmergencyActive(channelId);

    if (!hasActiveTransmission && !isEmergency) {
      this.log('DISCONNECTING_IDLE', { channelId });
      try {
        await this.dispatcher.leaveRoom();
      } catch (err) {
        this.log('DISCONNECT_ERROR', { channelId, error: err.message });
      }
    }
  }

  getTransmissionLogs(options = {}) {
    const { channelId, unitId, since, limit } = options;
    
    let logs = [...this.transmissionLogs];
    
    if (channelId) {
      logs = logs.filter(l => l.channelId === channelId);
    }
    if (unitId) {
      logs = logs.filter(l => l.unitId === unitId);
    }
    if (since) {
      logs = logs.filter(l => l.startTime >= since);
    }
    if (limit) {
      logs = logs.slice(-limit);
    }
    
    return logs;
  }

  getTotalConnectionTime(channelId) {
    const logs = this.transmissionLogs.filter(l => 
      l.channelId === channelId && l.endTime
    );
    return logs.reduce((sum, l) => sum + (l.duration || 0), 0);
  }

  clearLogs() {
    this.transmissionLogs = [];
  }
}

export const aiDispatcherSignaling = new AIDispatcherSignaling();
