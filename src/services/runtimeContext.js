import { AsyncLocalStorage } from 'async_hooks';

const runtimeStorage = new AsyncLocalStorage();
const LEGACY_RUNTIME_ID = 'legacy';
const KEY_SEPARATOR = '\u001f';

function normalizeContext(context = {}) {
  const runtimeId = String(context.runtimeId || context.profileId || LEGACY_RUNTIME_ID);
  return Object.freeze({
    runtimeId,
    profileId: context.profileId || (runtimeId === LEGACY_RUNTIME_ID ? null : runtimeId),
    profileName: context.profileName || null,
    dispatchCenterId: context.dispatchCenterId || process.env.CAD_DISPATCH_CENTER_ID || null,
    dispatchCenterName: context.dispatchCenterName || null,
    agencyId: context.agencyId || process.env.CAD_AGENCY_ID || null,
    cadUrl: context.cadUrl || process.env.CAD_URL || null,
    cadApiKey: context.cadApiKey || process.env.CAD_API_KEY || null,
    channelId: context.channelId || null,
    channelName: context.channelName || null,
    roomKey: context.roomKey || null,
    identity: context.identity || 'AI-Dispatcher',
    managed: context.managed === true,
  });
}

export function getRuntimeContext() {
  return runtimeStorage.getStore() || normalizeContext();
}

export function getRuntimeId() {
  return getRuntimeContext().runtimeId;
}

export function runWithRuntime(context, fn) {
  return runtimeStorage.run(normalizeContext(context), fn);
}

export function bindRuntime(context, fn) {
  const normalized = normalizeContext(context);
  return function runtimeBound(...args) {
    return runtimeStorage.run(normalized, () => fn.apply(this, args));
  };
}

export function createRuntimeScopedMap() {
  const backing = new Map();
  const prefixed = (key) => `${getRuntimeId()}${KEY_SEPARATOR}${String(key)}`;
  const currentPrefix = () => `${getRuntimeId()}${KEY_SEPARATOR}`;
  const strip = (key) => String(key).slice(String(key).indexOf(KEY_SEPARATOR) + 1);

  return {
    has(key) { return backing.has(prefixed(key)); },
    get(key) { return backing.get(prefixed(key)); },
    set(key, value) { backing.set(prefixed(key), value); return this; },
    delete(key) { return backing.delete(prefixed(key)); },
    clear() {
      const prefix = currentPrefix();
      for (const key of [...backing.keys()]) {
        if (String(key).startsWith(prefix)) backing.delete(key);
      }
    },
    clearAll() { backing.clear(); },
    keys() {
      const prefix = currentPrefix();
      return [...backing.keys()].filter(k => String(k).startsWith(prefix)).map(strip)[Symbol.iterator]();
    },
    values() {
      const prefix = currentPrefix();
      return [...backing.entries()].filter(([k]) => String(k).startsWith(prefix)).map(([, v]) => v)[Symbol.iterator]();
    },
    entries() {
      const prefix = currentPrefix();
      return [...backing.entries()].filter(([k]) => String(k).startsWith(prefix)).map(([k, v]) => [strip(k), v])[Symbol.iterator]();
    },
    forEach(callback, thisArg) {
      for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
    },
    get size() {
      const prefix = currentPrefix();
      let count = 0;
      for (const key of backing.keys()) if (String(key).startsWith(prefix)) count += 1;
      return count;
    },
    [Symbol.iterator]() { return this.entries(); },
    _backing: backing,
  };
}

export const LEGACY_RUNTIME_CONTEXT = normalizeContext();
