import { getDispatcher } from './aiDispatchService.js';

export class AIDispatcherSignaling {
  initialize() {
    return true;
  }

  setActiveChannel() {
    return true;
  }

  removeActiveChannel() {
    return true;
  }

  async handlePttStart(channelId, unitId, isEmergency = false) {
    const dispatcher = getDispatcher();
    if (!dispatcher) return false;
    return dispatcher.handlePttStart(channelId, unitId, isEmergency);
  }

  async handlePttEnd(channelId, unitId, gracePeriodMs = null) {
    const dispatcher = getDispatcher();
    if (!dispatcher) return false;
    return dispatcher.handlePttEnd(channelId, unitId, gracePeriodMs);
  }

  async handleEmergencyStart(channelId, unitId) {
    const dispatcher = getDispatcher();
    if (!dispatcher) return false;
    return dispatcher.handleEmergencyStart(channelId, unitId);
  }

  async handleEmergencyEnd(channelId, unitId) {
    const dispatcher = getDispatcher();
    if (!dispatcher) return false;
    return dispatcher.handleEmergencyEnd(channelId, unitId);
  }
}

export const aiDispatcherSignaling = new AIDispatcherSignaling();
