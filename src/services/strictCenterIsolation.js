import { AIDispatcher } from './aiDispatchService.js';
import { AIDispatcherSignaling } from './aiDispatcherSignaling.js';
import { getStatusCheck } from './cadService.js';
import {
  normalizeCenterUnitId,
  restrictManagedAliases,
  unitAppearsInCenter,
} from './strictCenterPolicy.js';

let installed = false;
const guardState = new WeakMap();

async function checkUnitInCurrentDispatchCenter(unitId) {
  const normalized = normalizeCenterUnitId(unitId);
  if (!normalized) return { allowed: false, reason: 'unit_id_required' };

  const result = await getStatusCheck();
  if (!result || result.success === false) {
    return {
      allowed: false,
      reason: 'cad_unit_read_failed',
      error: result?.error || 'Unable to read CAD units',
      failureType: result?.failureType || null,
      statusCode: result?.statusCode ?? null,
    };
  }
  if (!Array.isArray(result.units)) {
    return { allowed: false, reason: 'malformed_unit_response' };
  }

  const allowed = unitAppearsInCenter(result.units, normalized);
  return {
    allowed,
    reason: allowed ? 'unit_in_dispatch_center' : 'unit_not_in_dispatch_center',
    unitId: normalized,
  };
}

function guardFor(dispatcher) {
  let state = guardState.get(dispatcher);
  if (state) return state.guard;

  const cache = new Map();
  const guard = async (unitId) => {
    const key = normalizeCenterUnitId(unitId);
    if (!key) return false;

    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) return cached.allowed;

    let decision;
    try {
      decision = await checkUnitInCurrentDispatchCenter(key);
    } catch (error) {
      decision = { allowed: false, reason: 'center_guard_error', error: error.message };
    }

    const allowed = decision.allowed === true;
    cache.set(key, {
      allowed,
      expiresAt: now + (allowed ? 30000 : 5000),
    });

    if (!allowed) {
      dispatcher.log?.('UNIT_CENTER_ACCESS_BLOCKED', {
        profileId: dispatcher.profileId,
        unitId: key,
        dispatchCenterId: dispatcher.dispatchCenterId,
        reason: decision.reason,
        error: decision.error || null,
      });
    }
    return allowed;
  };

  state = { cache, guard };
  guardState.set(dispatcher, state);
  return guard;
}

async function signalingUnitAllowed(adapter, unitId) {
  const dispatcher = adapter?.dispatcher;
  if (!dispatcher?.profileManaged) return true;
  const guard = dispatcher.unitAccessGuard || guardFor(dispatcher);
  dispatcher.unitAccessGuard = guard;
  return guard(unitId);
}

export function installStrictCenterIsolation() {
  if (installed) return;
  installed = true;

  const originalResolveAliases = AIDispatcher.prototype._resolveChannelAliases;
  AIDispatcher.prototype._resolveChannelAliases = async function strictResolveAliases(channelName, roomKey) {
    const canonical = this.profileManaged
      ? String(roomKey || this.runtimeContext?.roomKey || this.configuredChannel || '').trim()
      : roomKey;
    await originalResolveAliases.call(this, this.profileManaged ? canonical : channelName, canonical);
    if (this.profileManaged) {
      if (!canonical) throw new Error('Managed AI dispatcher requires a canonical room key');
      restrictManagedAliases(this.channelAliases, canonical, this.numericChannelId);
      this.log?.('CHANNEL_CENTER_ISOLATION_APPLIED', {
        profileId: this.profileId,
        dispatchCenterId: this.dispatchCenterId,
        roomKey: canonical,
        aliases: Array.from(this.channelAliases),
      });
    }
  };

  const originalStart = AIDispatcher.prototype.start;
  AIDispatcher.prototype.start = async function strictStart(channelName, options = {}) {
    if (!this.profileManaged) return originalStart.call(this, channelName, options);

    const canonical = String(options.roomKey || this.runtimeContext?.roomKey || '').trim();
    if (!canonical) throw new Error('Managed AI dispatcher requires a canonical room key');
    this.unitAccessGuard = guardFor(this);
    return originalStart.call(this, canonical, { ...options, roomKey: canonical });
  };

  for (const methodName of ['handlePttStart', 'handlePttEnd', 'handleEmergencyStart', 'handleEmergencyEnd']) {
    const original = AIDispatcherSignaling.prototype[methodName];
    AIDispatcherSignaling.prototype[methodName] = async function strictSignalingBoundary(channelId, unitId, ...args) {
      if (!(await signalingUnitAllowed(this, unitId))) {
        this.log?.('SIGNALING_CENTER_FILTERED', {
          method: methodName,
          channelId,
          unitId,
          dispatchCenterId: this.dispatcher?.dispatchCenterId || null,
        });
        return;
      }
      return original.call(this, channelId, unitId, ...args);
    };
  }

  console.log('[AI-CENTER-ISOLATION] Strict dispatch-center boundaries installed');
}
