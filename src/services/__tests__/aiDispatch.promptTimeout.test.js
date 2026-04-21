import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

process.env.AI_PER_PROMPT_TIMEOUT_MS = '50';

let setUnitSessionState, getUnitSessionState, resetDispatcherState, DISPATCHER_STATE;

beforeAll(async () => {
  const mod = await import('../commandMatcher.js');
  setUnitSessionState = mod.setUnitSessionState;
  getUnitSessionState = mod.getUnitSessionState;
  resetDispatcherState = mod.resetDispatcherState;
  DISPATCHER_STATE = mod.DISPATCHER_STATE;
});

describe('per-prompt timeout', () => {
  beforeEach(() => {
    resetDispatcherState();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('non-emergency prompt expires back to IDLE after timeout', async () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.AWAITING_LOCATION, { intent: 'TRAFFIC_STOP' });
    expect(getUnitSessionState('Indiana-1').state).toBe(DISPATCHER_STATE.AWAITING_LOCATION);

    await new Promise(r => setTimeout(r, 120));

    expect(getUnitSessionState('Indiana-1').state).toBe(DISPATCHER_STATE.IDLE);
  });

  it('emergency-flagged pendingIntent does NOT trigger per-prompt timeout', async () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE, { intent: 'EMERGENCY' });
    expect(getUnitSessionState('Indiana-1').state).toBe(DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE);

    await new Promise(r => setTimeout(r, 120));

    expect(getUnitSessionState('Indiana-1').state).toBe(DISPATCHER_STATE.AWAITING_STATUS_CHECK_RESPONSE);
  });

  it('IDLE state does not arm a per-prompt timeout', async () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.IDLE, null, {}, true);
    await new Promise(r => setTimeout(r, 120));
    expect(getUnitSessionState('Indiana-1').state).toBe(DISPATCHER_STATE.IDLE);
  });
});
