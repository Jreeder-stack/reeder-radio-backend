import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

export const DISPATCHER_V3_RUNTIME_VERSION = '3';

export function normalizeV3RuntimeContext(input = {}) {
  const scopes = normalizeScopes(input.scopes ?? input.cadScopes ?? []);
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
    cadUrl: normalizeUrl(input.cadUrl),
    cadApiKey: clean(input.cadApiKey),
    scopes,
    managed: input.managed !== false,
  };

  return Object.freeze(context);
}

export function validateV3RuntimeContext(context, options = {}) {
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
  if (options.requireCad !== false && (!clean(context.cadUrl) || !clean(context.cadApiKey))) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT,
      'Dispatcher V3 requires Command Link URL and API credentials',
      { details: { missingCadUrl: !clean(context.cadUrl), missingCadApiKey: !clean(context.cadApiKey) } },
    );
  }
  return true;
}

export function buildV3RuntimeContext(input = {}, options = {}) {
  const context = normalizeV3RuntimeContext(input);
  validateV3RuntimeContext(context, options);
  return context;
}

export function assertV3ContextMatches(expected, actual) {
  validateV3RuntimeContext(expected);
  validateV3RuntimeContext(actual);
  if (expected.runtimeId !== actual.runtimeId) {
    throw isolationError('runtime', expected.runtimeId, actual.runtimeId);
  }
  if (expected.dispatchCenterId !== actual.dispatchCenterId) {
    throw isolationError('dispatch center', expected.dispatchCenterId, actual.dispatchCenterId);
  }
  if (String(expected.channelId) !== String(actual.channelId) || expected.roomKey !== actual.roomKey) {
    throw isolationError(
      'radio channel',
      `${expected.channelId}:${expected.roomKey}`,
      `${actual.channelId}:${actual.roomKey}`,
    );
  }
  return true;
}

export function hasV3Scope(context, requiredScope) {
  const required = clean(requiredScope);
  if (!required) return false;
  const scopes = Array.isArray(context?.scopes) ? context.scopes : [];
  return scopes.includes('*') || scopes.includes(required);
}

export function requireV3Scopes(context, requiredScopes = []) {
  const required = normalizeScopes(requiredScopes);
  const missing = required.filter((scope) => !hasV3Scope(context, scope));
  if (missing.length > 0) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.UNAUTHORIZED,
      `Dispatcher V3 runtime is missing required scope${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`,
      { statusCode: 403, details: { missingScopes: missing } },
    );
  }
  return true;
}

export function normalizeScopes(input) {
  const values = Array.isArray(input) ? input : [input];
  return Object.freeze(Array.from(new Set(
    values
      .map((value) => clean(value))
      .filter(Boolean),
  )));
}

function isolationError(resource, expected, actual) {
  return new DispatcherV3Error(
    V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT,
    `Dispatcher V3 ${resource} context mismatch`,
    {
      statusCode: 409,
      details: { resource, expected, actual },
    },
  );
}

function normalizeUrl(value) {
  const text = clean(value);
  return text ? text.replace(/\/+$/, '') : null;
}

function clean(value) {
  const text = String(value ?? '').trim();
  return text || null;
}
