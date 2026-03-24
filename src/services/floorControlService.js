const FLOOR_HOLD_TIMEOUT_MS = 30000;

class FloorControlService {
  constructor() {
    this.floorHolders = new Map();
    this.floorTimers = new Map();
  }

  requestFloor(channelId, unitId, { isEmergency = false, emergencyStates = null } = {}) {
    const key = String(channelId);
    const current = this.floorHolders.get(key);

    if (current && current.unitId === unitId) {
      this._rearmTimer(key, unitId);
      return { granted: true, channelId: key, unitId, timestamp: Date.now() };
    }

    if (current) {
      const currentIsEmergency = current.isEmergency;

      if (isEmergency && !currentIsEmergency) {
        this._clearTimer(key);
        const preempted = current.unitId;
        this._setFloor(key, unitId, true);
        return {
          granted: true,
          channelId: key,
          unitId,
          timestamp: Date.now(),
          preemptedUnit: preempted,
          isEmergency: true,
        };
      }

      return {
        granted: false,
        channelId: key,
        unitId,
        timestamp: Date.now(),
        heldBy: current.unitId,
        reason: currentIsEmergency ? 'emergency_active' : 'channel_busy',
      };
    }

    this._setFloor(key, unitId, isEmergency);
    return { granted: true, channelId: key, unitId, timestamp: Date.now(), isEmergency };
  }

  releaseFloor(channelId, unitId) {
    const key = String(channelId);
    const current = this.floorHolders.get(key);
    if (!current || current.unitId !== unitId) {
      return false;
    }
    this._clearTimer(key);
    this.floorHolders.delete(key);
    return true;
  }

  forceRelease(channelId) {
    const key = String(channelId);
    const current = this.floorHolders.get(key);
    this._clearTimer(key);
    this.floorHolders.delete(key);
    return current || null;
  }

  holdsFloor(channelId, unitId) {
    const key = String(channelId);
    const current = this.floorHolders.get(key);
    return current ? current.unitId === unitId : false;
  }

  getFloorHolder(channelId) {
    const key = String(channelId);
    return this.floorHolders.get(key) || null;
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

  _setFloor(key, unitId, isEmergency) {
    this.floorHolders.set(key, {
      unitId,
      isEmergency,
      grantedAt: Date.now(),
    });

    this._clearTimer(key);
    const timer = setTimeout(() => {
      const current = this.floorHolders.get(key);
      if (current && current.unitId === unitId) {
        this.floorHolders.delete(key);
        this.floorTimers.delete(key);
        console.log(`[FloorControl] Timeout: released floor on ${key} from ${unitId}`);
        if (this._onTimeout) {
          this._onTimeout(key, unitId);
        }
      }
    }, FLOOR_HOLD_TIMEOUT_MS);

    timer.unref?.();
    this.floorTimers.set(key, timer);
  }

  _rearmTimer(key, unitId) {
    this._clearTimer(key);
    const current = this.floorHolders.get(key);
    if (!current) return;
    current.grantedAt = Date.now();
    const timer = setTimeout(() => {
      const cur = this.floorHolders.get(key);
      if (cur && cur.unitId === unitId) {
        this.floorHolders.delete(key);
        this.floorTimers.delete(key);
        console.log(`[FloorControl] Timeout: released floor on ${key} from ${unitId}`);
        if (this._onTimeout) {
          this._onTimeout(key, unitId);
        }
      }
    }, FLOOR_HOLD_TIMEOUT_MS);
    timer.unref?.();
    this.floorTimers.set(key, timer);
  }

  _clearTimer(key) {
    const timer = this.floorTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.floorTimers.delete(key);
    }
  }

  onTimeout(callback) {
    this._onTimeout = callback;
  }
}

export const floorControlService = new FloorControlService();
