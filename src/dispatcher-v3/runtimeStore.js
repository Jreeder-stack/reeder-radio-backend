import { AsyncLocalStorage } from 'async_hooks';
import { buildV3RuntimeContext, assertV3ContextMatches } from './runtimeContract.js';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

const runtimeStorage = new AsyncLocalStorage();

export function runWithV3Runtime(context, fn) {
  const normalized = buildV3RuntimeContext(context);
  return runtimeStorage.run(normalized, fn);
}

export function bindV3Runtime(context, fn) {
  const normalized = buildV3RuntimeContext(context);
  return function boundV3Runtime(...args) {
    return runtimeStorage.run(normalized, () => fn.apply(this, args));
  };
}

export function getV3RuntimeContext() {
  const context = runtimeStorage.getStore();
  if (!context) {
    throw new DispatcherV3Error(
      V3_ERROR_CODES.INVALID_RUNTIME_CONTEXT,
      'Dispatcher V3 operation attempted outside an active runtime context',
    );
  }
  return context;
}

export function assertCurrentV3Runtime(expectedContext) {
  const actual = getV3RuntimeContext();
  assertV3ContextMatches(buildV3RuntimeContext(expectedContext), actual);
  return actual;
}
