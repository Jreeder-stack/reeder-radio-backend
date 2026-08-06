import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

export const DISPATCHER_V3_RUNTIME_VERSION = '3';

export function normalizeV3RuntimeContext(input = {}) {
  const context = {
    version: DISPATCHER_V3_RUNTIME_VERSION,
    runtimeId: clean(input.runtimeId),
    profileId: clean(input.profileId),
    profileName: clean(input.profileName),
    dispatchCenterId: clean(input.dispatchCenterId),
    dispatchCenterName: clean(input.dispatchCenterName),
    agencyId: clean(input.agencyId),
    channelId: input.channelId ?? null,
    channelName: clean(input.channelName),
    roomKey: clean(input.roomKey),
    identity: clean(input.identity),
    cadUrl: clean(input.cadUrl),
    cadApiKey: clean(input.cadApiKey),
    managed: input.managed !== false,
  };

  return Object.freeze(context);
}

export function validateV3RuntimeContext(context) {
  if (!context || typeof context !== 'object') {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT,
      'Dispatcher V3 runtime context is required',
    );
  }
  if (!clean(context.dispatchCenterId)) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.DISPATCH_CENTER_REQUIRED,
      'Dispatcher V3 requires an assigned dispatch center',
    );
  }
  if (context.channelId == null || !clean(context.roomKey)) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.CHANNEL_REQUIRED,
      'Dispatcher V3 requires an assigned radio channel',
    );
  }
  if (!clean(context.runtimeId) || !clean(context.profileId) || !clean(context.identity)) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT,
      'Dispatcher V3 requires runtimeId, profileId, and identity',
    );
  }
  return true;
}

export function buildV3RuntimeContext(input = {}) {
  const context = normalizeV3RuntimeContext(input);
  validateV3RuntimeContext(context);
  return context;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
