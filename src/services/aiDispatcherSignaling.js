import { signalingService, SIGNALING_EVENTS } from './signalingService.js';

const AI_UNIT_ID = 'AI-Dispatcher';

class AIDispatcherSignaling {
  constructor() {
    this.dispatcher = null;
    this.activeChannels = new Set();
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
    const key = String(channelId);
    this.activeChannels.add(key);
    this.log('CHANNEL_ACTIVATED', { channelId: key });
  }

  removeActiveChannel(channelId) {
    const key = String(channelId);
    this.activeChannels.delete(key);
    this.log('CHANNEL_DEACTIVATED', { channelId: key });
  }

  _matchesChannel(channelId) {
    if (this.activeChannels.has(channelId)) return true;
    if (this.dispatcher && this.dispatcher.matchesChannel) {
      return this.dispatcher.matchesChannel(channelId);
    }
    return false;
  }

  async handlePttStart(channelId, unitId, isEmergency = false) {
    if (!this.dispatcher) {
      this.log('PTT_IGNORED', { reason: 'Dispatcher not initialized' });
      return;
    }

    if (!this._matchesChannel(channelId)) {
      this.log('PTT_IGNORED', { channelId, reason: 'Channel not active', activeChannels: Array.from(this.activeChannels) });
      return;
    }

    if (unitId === AI_UNIT_ID) {
      return;
    }

    this.log('PTT_START_DETECTED', { channelId, unitId, isEmergency });

    const transmissionLog = {
      channelId,
      unitId,
      startTime: Date.now(),
      isEmergency,
    };
    this.transmissionLogs.push(transmissionLog);

    signalingService.sendPttReady(channelId, unitId);
    this.log('PTT_READY_SENT', { channelId, unitId, alreadyConnected: this.dispatcher.connected });
  }

  async handlePttEnd(channelId, unitId) {
    if (!this.dispatcher) return;
    if (!this._matchesChannel(channelId)) return;
    if (unitId === AI_UNIT_ID) return;

    this.log('PTT_END_DETECTED', { channelId, unitId });

    const log = this.transmissionLogs.find(
      l => l.channelId === channelId && l.unitId === unitId && !l.endTime
    );
    if (log) {
      log.endTime = Date.now();
      log.duration = log.endTime - log.startTime;
    }
  }

  async handleEmergencyStart(channelId, unitId) {
    if (!this.dispatcher) return;
    if (!this._matchesChannel(channelId)) return;

    this.log('EMERGENCY_START_DETECTED', { channelId, unitId });

    if (this.dispatcher.emergencyEscalation) {
      try {
        this.log('EMERGENCY_ESCALATION_WAITING', { channelId, unitId, delayMs: 3000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
        await this.dispatcher.emergencyEscalation.startEscalation(unitId, channelId);
        this.log('EMERGENCY_ESCALATION_TRIGGERED', { channelId, unitId });
      } catch (err) {
        this.log('EMERGENCY_ESCALATION_ERROR', { channelId, unitId, error: err.message });
      }
    }
  }

  async handleEmergencyEnd(channelId, unitId) {
    if (!this.dispatcher) return;

    this.log('EMERGENCY_END_DETECTED', { channelId, unitId });

    if (this.dispatcher.emergencyEscalation) {
      this.dispatcher.emergencyEscalation.clearEscalation(unitId);
      this.log('EMERGENCY_ESCALATION_CLEARED', { channelId, unitId });
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
