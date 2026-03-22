const FLOOR_HOLD_TIMEOUT_MS = 30000;

class FloorControlService {
  constructor() {
    this.floorHolders = new Map();
    this.floorTimers = new Map();
  }

  requestFloor(channelId, unitId, { isEmergency = false, emergencyStates = null } = {}) {
    const current = this.floorHolders.get(channelId);

    if (current && current.unitId === unitId) {
      return { granted: true, channelId, unitId, timestamp: Date.now() };
    }

    if (current) {
      const currentIsEmergency = current.isEmergency;

      if (isEmergency && !currentIsEmergency) {
        this._clearTimer(channelId);
        const preempted = current.unitId;
        this._setFloor(channelId, unitId, true);
        return {
          granted: true,
          channelId,
          unitId,
          timestamp: Date.now(),
          preemptedUnit: preempted,
          isEmergency: true,
        };
      }

      return {
        granted: false,
        channelId,
        unitId,
        timestamp: Date.now(),
        heldBy: current.unitId,
        reason: currentIsEmergency ? 'emergency_active' : 'channel_busy',
      };
    }

    this._setFloor(channelId, unitId, isEmergency);
    return { granted: true, channelId, unitId, timestamp: Date.now(), isEmergency };
  }

  releaseFloor(channelId, unitId) {
    const current = this.floorHolders.get(channelId);
    if (!current || current.unitId !== unitId) {
      return false;
    }
    this._clearTimer(channelId);
    this.floorHolders.delete(channelId);
    return true;
  }

  forceRelease(channelId) {
    const current = this.floorHolders.get(channelId);
    this._clearTimer(channelId);
    this.floorHolders.delete(channelId);
    return current || null;
  }

  holdsFloor(channelId, unitId) {
    const current = this.floorHolders.get(channelId);
    return current ? current.unitId === unitId : false;
  }

  getFloorHolder(channelId) {
    return this.floorHolders.get(channelId) || null;
  }

  releaseAllForUnit(unitId) {
    const released = [];
    for (const [channelId, holder] of this.floorHolders) {
      if (holder.unitId === unitId) {
        this._clearTimer(channelId);
        this.floorHolders.delete(channelId);
        released.push(channelId);
      }
    }
    return released;
  }

  _setFloor(channelId, unitId, isEmergency) {
    this.floorHolders.set(channelId, {
      unitId,
      isEmergency,
      grantedAt: Date.now(),
    });

    this._clearTimer(channelId);
    const timer = setTimeout(() => {
      const current = this.floorHolders.get(channelId);
      if (current && current.unitId === unitId) {
        this.floorHolders.delete(channelId);
        this.floorTimers.delete(channelId);
        console.log(`[FloorControl] Timeout: released floor on ${channelId} from ${unitId}`);
        if (this._onTimeout) {
          this._onTimeout(channelId, unitId);
        }
      }
    }, FLOOR_HOLD_TIMEOUT_MS);

    timer.unref?.();
    this.floorTimers.set(channelId, timer);
  }

  _clearTimer(channelId) {
    const timer = this.floorTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.floorTimers.delete(channelId);
    }
  }

  onTimeout(callback) {
    this._onTimeout = callback;
  }
}

export const floorControlService = new FloorControlService();
