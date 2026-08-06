export const DISPATCHER_RUNTIME = Object.freeze({
  LEGACY: 'legacy',
  V3: 'v3',
});

export function getConfiguredDispatcherRuntime(env = process.env) {
  const requested = String(env.AI_DISPATCHER_RUNTIME || '').trim().toLowerCase();
  return requested === DISPATCHER_RUNTIME.V3
    ? DISPATCHER_RUNTIME.V3
    : DISPATCHER_RUNTIME.LEGACY;
}

export function isDispatcherV3Selected(env = process.env) {
  return getConfiguredDispatcherRuntime(env) === DISPATCHER_RUNTIME.V3;
}
