import { canonicalChannelKey } from './channelKeyUtils.js';

const FLOOR_HOLD_TIMEOUT_MS = 30000;
const AI_FLOOR_HOLD_TIMEOUT_MS = 3000;
export const AI_FLOOR_IDENTITY = 'AI-Dispatcher';

class FloorControlService {
  constructor() {
    this.floorHolders = new Map();
    this.floorTimers = new Map();
  }

  requestFloor(channelId, floorKey, { isEmergency = false, isClearAir = false, emergencyStates = null } = {}) {
    const key = canonicalChannelKey(channelId);
    console.log(`[FloorControl] requestFloor: raw="${channelId}" canonical="${key}" floorKey="${floorKey}" isClearAir=${isClearAir}`);

    const current = this.floorHolders.get(key);

    if (current && current.floorKey === floorKey) {
      this._rearmTimer(key, floorKey);
      return { granted: true, channelId: key, floorKey, unitId: floorKey, timestamp: Date.now() };
    }

    if (current) {
      const currentIsEmergency = current.isEmergency;
      const currentIsClearAir = current.isClearAir;

      if (isEmergency && !currentIsEmergency) {
        this._clearTimer(key);
        const preempted = current.floorKey;
        this._setFloor(key, floorKey, true, false);
        return {
          granted: true,
          channelId: key,
          floorKey,
          unitId: floorKey,
          timestamp: Date.now(),
          preemptedUnit: preempted,
          isEmergency: true,
        };
      }

      if (currentIsClearAir && !isClearAir) {
        this._clearTimer(key);
        const preempted = current.floorKey;
        this._setFloor(key, floorKey, isEmergency, false);
        return {
          granted: true,
          channelId: key,
          floorKey,
          unitId: floorKey,
          timestamp: Date.now(),
          preemptedUnit: preempted,
          preemptedClearAir: true,
        };
      }

      return {
        granted: false,
        channelId: key,
        floorKey,
        unitId: floorKey,
        timestamp: Date.now(),
        heldBy: current.floorKey,
        heldByFloorKey: current.floorKey,
        reason: currentIsEmergency ? 'emergency_active' : 'channel_busy',
      };
    }

    this._setFloor(key, floorKey, isEmergency, isClearAir);
    return { granted: true, channelId: key, floorKey, unitId: floorKey, timestamp: Date.now(), isEmergency, isClearAir };
  }

  releaseFloor(channelId, floorKey) {
    const key = canonicalChannelKey(channelId);
    const current = this.floorHolders.get(key);
    if (!current || current.floorKey !== floorKey) {
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

  holdsFloor(channelId, floorKey) {
    const key = canonicalChannelKey(channelId);
    const current = this.floorHolders.get(key);
    const holds = current ? current.floorKey === floorKey : false;
    if (!holds && !this._holdsFloorLogThrottle) {
      this._holdsFloorLogThrottle = true;
      const allKeys = [...this.floorHolders.keys()];
      console.log(`[FloorControl] holdsFloor MISS: query key="${key}" floorKey="${floorKey}" holder=${current ? current.floorKey : 'none'} allFloorKeys=[${allKeys.join(',')}]`);
      setTimeout(() => { this._holdsFloorLogThrottle = false; }, 2000);
    }
    return holds;
  }

  getActiveFloors() {
    const floors = {};
    for (const [key, holder] of this.floorHolders) {
      floors[key] = { floorKey: holder.floorKey, unitId: holder.unitId, grantedAt: holder.grantedAt };
    }
    return floors;
  }

  getFloorHolder(channelId) {
    const key = canonicalChannelKey(channelId);
    return this.floorHolders.get(key) || null;
  }

  releaseAllForFloorKey(floorKey) {
    const released = [];
    for (const [channelId, holder] of this.floorHolders) {
      if (holder.floorKey === floorKey) {
        this._clearTimer(channelId);
        this.floorHolders.delete(channelId);
        released.push(channelId);
      }
    }
    return released;
  }

  // Compatibility alias for older callers. The argument is a floor/device key,
  // not a human-readable unit id.
  releaseAllForUnit(floorKey) {
    return this.releaseAllForFloorKey(floorKey);
  }

  _timeoutForFloorKey(floorKey) {
    return floorKey === AI_FLOOR_IDENTITY ? AI_FLOOR_HOLD_TIMEOUT_MS : FLOOR_HOLD_TIMEOUT_MS;
  }

  _setFloor(key, floorKey, isEmergency, isClearAir = false) {
    this.floorHolders.set(key, {
      floorKey,
      // Legacy compatibility: historically this property contained the same
      // opaque floor/device identity. Keep it until every caller uses floorKey.
      unitId: floorKey,
      isEmergency,
      isClearAir,
      grantedAt: Date.now(),
    });

    this._clearTimer(key);
    const timeoutMs = this._timeoutForFloorKey(floorKey);
    const timer = setTimeout(() => {
      const current = this.floorHolders.get(key);
      if (current && current.floorKey === floorKey) {
        this.floorHolders.delete(key);
        this.floorTimers.delete(key);
        if (floorKey === AI_FLOOR_IDENTITY) {
          console.log(`[FloorControl] AI watchdog released floor on ${key}`);
        } else {
          console.log(`[FloorControl] Timeout: released floor on ${key} from floorKey=${floorKey}`);
        }
        if (this._onTimeout) {
          this._onTimeout(key, floorKey);
        }
      }
    }, timeoutMs);

    timer.unref?.();
    this.floorTimers.set(key, timer);
  }

  _rearmTimer(key, floorKey) {
    this._clearTimer(key);
    const current = this.floorHolders.get(key);
    if (!current) return;
    current.grantedAt = Date.now();
    const timeoutMs = this._timeoutForFloorKey(floorKey);
    const timer = setTimeout(() => {
      const cur = this.floorHolders.get(key);
      if (cur && cur.floorKey === floorKey) {
        this.floorHolders.delete(key);
        this.floorTimers.delete(key);
        if (floorKey === AI_FLOOR_IDENTITY) {
          console.log(`[FloorControl] AI watchdog released floor on ${key}`);
        } else {
          console.log(`[FloorControl] Timeout: released floor on ${key} from floorKey=${floorKey}`);
        }
        if (this._onTimeout) {
          this._onTimeout(key, floorKey);
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
