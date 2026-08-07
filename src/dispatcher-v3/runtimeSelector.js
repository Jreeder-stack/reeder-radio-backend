export const DISPATCHER_RUNTIME = Object.freeze({
  LEGACY: 'legacy',
  V3: 'v3',
});

export function getConfiguredDispatcherRuntime(env = process.env) {
  const requested = String(env.AI_DISPATCHER_RUNTIME || '').trim().toLowerCase();
  return requested === DISPATCHER_RUNTIME.LEGACY
    ? DISPATCHER_RUNTIME.LEGACY
    : DISPATCHER_RUNTIME.V3;
}

export function isDispatcherV3Selected(env = process.env) {
  return getConfiguredDispatcherRuntime(env) === DISPATCHER_RUNTIME.V3;
}
