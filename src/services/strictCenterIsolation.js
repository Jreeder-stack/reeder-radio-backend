import { getStatusCheck } from './cadService.js';

function normalizeUnitId(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '-');
}

export async function checkUnitInCurrentDispatchCenter(unitId) {
  const normalized = normalizeUnitId(unitId);
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

  const unit = result.units.find((candidate) => normalizeUnitId(
    candidate?.unit_id
      || candidate?.unit_number
      || candidate?.unitNumber
      || candidate?.callsign
      || candidate?.call_sign,
  ) === normalized) || null;

  return {
    allowed: !!unit,
    reason: unit ? 'unit_in_dispatch_center' : 'unit_not_in_dispatch_center',
    unit,
    unitId: normalized,
  };
}

export function configureStrictCenterIsolation(dispatcher, profile, log = () => {}) {
  const accessCache = new Map();
  const originalResolveAliases = dispatcher._resolveChannelAliases.bind(dispatcher);

  dispatcher._resolveChannelAliases = async (channelName, roomKey) => {
    await originalResolveAliases(channelName, roomKey);
    const bareName = String(profile.channel_name || '').trim();
    const canonicalRoomKey = String(profile.room_key || roomKey || '').trim();

    if (bareName && bareName !== canonicalRoomKey) {
      dispatcher.channelAliases.delete(bareName);
    }
    if (canonicalRoomKey) dispatcher.channelAliases.add(canonicalRoomKey);

    log('CHANNEL_CENTER_ISOLATION_APPLIED', {
      profileId: profile.id,
      dispatchCenterId: profile.dispatch_center_id,
      roomKey: canonicalRoomKey,
      aliases: Array.from(dispatcher.channelAliases),
    });
  };

  const unitAccessGuard = async (unitId) => {
    const key = normalizeUnitId(unitId);
    if (!key) return false;
    const now = Date.now();
    const cached = accessCache.get(key);
    if (cached && cached.expiresAt > now) return cached.allowed;

    const decision = await checkUnitInCurrentDispatchCenter(key);
    const allowed = decision.allowed === true;
    accessCache.set(key, {
      allowed,
      expiresAt: now + (allowed ? 30000 : 5000),
    });

    if (!allowed) {
      log('UNIT_CENTER_ACCESS_BLOCKED', {
        profileId: profile.id,
        unitId: key,
        dispatchCenterId: profile.dispatch_center_id,
        reason: decision.reason,
        error: decision.error || null,
      });
    }
    return allowed;
  };

  // aiDispatchService already enforces this hook at the audio-frame boundary.
  dispatcher.unitAccessGuard = unitAccessGuard;
  return unitAccessGuard;
}
