import { AsyncLocalStorage } from 'node:async_hooks';
import { DispatcherV3Error, V3_ERROR_CODES } from './errors.js';

// 01-04: per-request stage limits and an end-of-capture overall turn budget.
// This is not 01-05's credential, task-ownership or generation revalidation.
export const V3_DEADLINES = Object.freeze({
  turnMs: 60000, transcriptionMs: 15000, modelMs: 6500,
  cadMs: 8000, synthesisMs: 12000, sdkStopMs: 2500,
});
const storage = new AsyncLocalStorage();
function timeoutError(stage) {
  return new DispatcherV3Error(V3_ERROR_CODES.OPERATION_TIMEOUT,
    'Dispatcher V3 ' + stage + ' deadline exceeded', { statusCode: 504, retryable: false, details: { stage } });
}
export function createV3TurnBudget({ captureEndedAt = Date.now(), durationMs = V3_DEADLINES.turnMs } = {}) {
  const controller = new AbortController();
  const expiresAt = captureEndedAt + durationMs;
  const state = { signal: controller.signal, expiresAt, finished: false,
    finish() {
      if (state.finished) return;
      state.finished = true;
      clearTimeout(state.timer);
      controller.abort();
    },
  };
  state.timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now()));
  state.timer.unref?.();
  return state;
}
export function runWithV3Budget(budget, callback) {
  return storage.run(budget, callback);
}
export function currentV3Budget() { return storage.getStore() || null; }
export function assertV3DeadlineActive() {
  const budget = currentV3Budget();
  if (budget && (budget.finished || budget.signal.aborted || Date.now() >= budget.expiresAt)) {
    throw timeoutError('turn');
  }
  return budget;
}
// Races every asynchronous stage, even APIs that ignore AbortSignal.
// A late provider result is discarded and cannot authorize a follow-on action.
export async function withV3Stage(stage, timeoutMs, operation, { signal = null } = {}) {
  const budget = assertV3DeadlineActive();
  const remaining = budget ? budget.expiresAt - Date.now() : Infinity;
  const limit = Math.min(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000, remaining);
  if (limit <= 0) throw timeoutError(stage);
  const controller = new AbortController();
  const sources = [budget?.signal, signal].filter(Boolean);
  let timer;
  let rejectTimeout;
  let settled = false;
  const expiration = new Promise((_, reject) => { rejectTimeout = reject; });
  const cancel = () => {
    if (settled) return;
    controller.abort();
    rejectTimeout(timeoutError(stage));
  };
  for (const source of sources) source.addEventListener('abort', cancel, { once: true });
  try {
    if (sources.some((source) => source.aborted)) cancel();
    timer = setTimeout(cancel, limit);
    timer.unref?.();
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw timeoutError(stage);
      return operation({ signal: controller.signal, timeoutMs: limit });
    });
    const result = await Promise.race([work, expiration]);
    if (controller.signal.aborted) throw timeoutError(stage);
    assertV3DeadlineActive();
    return result;
  } finally {
    settled = true;
    clearTimeout(timer);
    for (const source of sources) source.removeEventListener('abort', cancel);
  }
}
