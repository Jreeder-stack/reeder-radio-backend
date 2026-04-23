import { canonicalChannelKey } from './channelKeyUtils.js';

const FLOOR_HOLD_TIMEOUT_MS = 30000;
const AI_FLOOR_HOLD_TIMEOUT_MS = 3000;
export const AI_FLOOR_IDENTITY = 'AI-Dispatcher';

class FloorControlService {
  constructor() {
    this.floorHolders = new Map();
    this.floorTimers = new Map();
  }

  requestFloor(channelId, unitId, { isEmergency = false, isClearAir = false, emergencyStates = null } = {}) {
    const key = canonicalChannelKey(channelId);
    console.log(`[FloorControl] requestFloor: raw="${channelId}" canonical="${key}" unitId="${unitId}" isClearAir=${isClearAir}`);

    const current = this.floorHolders.get(key);

    if (current && current.unitId === unitId) {
      this._rearmTimer(key, unitId);
      return { granted: true, channelId: key, unitId, timestamp: Date.now() };
    }

    if (current) {
      const currentIsEmergency = current.isEmergency;
      const currentIsClearAir = current.isClearAir;

      if (isEmergency && !currentIsEmergency) {
        this._clearTimer(key);
        const preempted = current.unitId;
        this._setFloor(key, unitId, true, false);
        return {
          granted: true,
          channelId: key,
          unitId,
          timestamp: Date.now(),
          preemptedUnit: preempted,
          isEmergency: true,
        };
      }

      if (currentIsClearAir && !isClearAir) {
        this._clearTimer(key);
        const preempted = current.unitId;
        this._setFloor(key, unitId, isEmergency, false);
        return {
          granted: true,
          channelId: key,
          unitId,
          timestamp: Date.now(),
          preemptedUnit: preempted,
          preemptedClearAir: true,
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

    this._setFloor(key, unitId, isEmergency, isClearAir);
    return { granted: true, channelId: key, unitId, timestamp: Date.now(), isEmergency, isClearAir };
  }

  releaseFloor(channelId, unitId) {
    const key = canonicalChannelKey(channelId);
    const current = this.floorHolders.get(key);
    if (!current || current.unitId !== unitId) {
      return false;
    }
    this._clearTimer(key);
    this.floorHolders.delete(key);
    return true;
  }

  forceRelease(channelId) {
    const key = canonicalChannelKey(channelId);
    const current = this.floorHolders.get(key);
    this._clearTimer(key);
    this.floorHolders.delete(key);
    return current || null;
  }

  holdsFloor(channelId, unitId) {
    const key = canonicalChannelKey(channelId);
    const current = this.floorHolders.get(key);
    const holds = current ? current.unitId === unitId : false;
    if (!holds && !this._holdsFloorLogThrottle) {
      this._holdsFloorLogThrottle = true;
      const allKeys = [...this.floorHolders.keys()];
      console.log(`[FloorControl] holdsFloor MISS: query key="${key}" unitId="${unitId}" holder=${current ? current.unitId : 'none'} allFloorKeys=[${allKeys.join(',')}]`);
      setTimeout(() => { this._holdsFloorLogThrottle = false; }, 2000);
    }
    return holds;
  }

  getActiveFloors() {
    const floors = {};
    for (const [key, holder] of this.floorHolders) {
      floors[key] = { unitId: holder.unitId, grantedAt: holder.grantedAt };
    }
    return floors;
  }

  getFloorHolder(channelId) {
    const key = canonicalChannelKey(channelId);
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

  _timeoutForUnit(unitId) {
    return unitId === AI_FLOOR_IDENTITY ? AI_FLOOR_HOLD_TIMEOUT_MS : FLOOR_HOLD_TIMEOUT_MS;
  }

  _setFloor(key, unitId, isEmergency, isClearAir = false) {
    this.floorHolders.set(key, {
      unitId,
      isEmergency,
      isClearAir,
      grantedAt: Date.now(),
    });

    this._clearTimer(key);
    const timeoutMs = this._timeoutForUnit(unitId);
    const timer = setTimeout(() => {
      const current = this.floorHolders.get(key);
      if (current && current.unitId === unitId) {
        this.floorHolders.delete(key);
        this.floorTimers.delete(key);
        if (unitId === AI_FLOOR_IDENTITY) {
          console.log(`[FloorControl] AI watchdog released floor on ${key}`);
        } else {
          console.log(`[FloorControl] Timeout: released floor on ${key} from ${unitId}`);
        }
        if (this._onTimeout) {
          this._onTimeout(key, unitId);
        }
      }
    }, timeoutMs);

    timer.unref?.();
    this.floorTimers.set(key, timer);
  }

  _rearmTimer(key, unitId) {
    this._clearTimer(key);
    const current = this.floorHolders.get(key);
    if (!current) return;
    current.grantedAt = Date.now();
    const timeoutMs = this._timeoutForUnit(unitId);
    const timer = setTimeout(() => {
      const cur = this.floorHolders.get(key);
      if (cur && cur.unitId === unitId) {
        this.floorHolders.delete(key);
        this.floorTimers.delete(key);
        if (unitId === AI_FLOOR_IDENTITY) {
          console.log(`[FloorControl] AI watchdog released floor on ${key}`);
        } else {
          console.log(`[FloorControl] Timeout: released floor on ${key} from ${unitId}`);
        }
        if (this._onTimeout) {
          this._onTimeout(key, unitId);
        }
      }
    }, timeoutMs);
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
export { FLOOR_HOLD_TIMEOUT_MS, AI_FLOOR_HOLD_TIMEOUT_MS };
