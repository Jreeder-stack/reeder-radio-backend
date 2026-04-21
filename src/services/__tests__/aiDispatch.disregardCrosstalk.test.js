import { describe, it, expect, beforeEach } from 'vitest';
import {
  ownsInFlight,
  setUnitSessionState,
  getUnitSessionState,
  resetDispatcherState,
  DISPATCHER_STATE,
} from '../commandMatcher.js';

describe('disregard cross-talk: ownsInFlight gating', () => {
  beforeEach(() => {
    resetDispatcherState();
  });

  it('returns false for a unit with no in-flight session', () => {
    expect(ownsInFlight('Indiana-1')).toBe(false);
  });

  it('returns true for a unit currently in a non-IDLE state', () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.AWAITING_LOCATION, { intent: 'TRAFFIC_STOP' });
    expect(ownsInFlight('Indiana-1')).toBe(true);
  });

  it('returns false for a different unit even when another unit is mid-flow', () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.AWAITING_LOCATION, { intent: 'TRAFFIC_STOP' });
    expect(ownsInFlight('Chester-2')).toBe(false);
  });

  it('preserves Indiana-1 session when Chester-2 says disregard (cross-talk simulation)', () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.AWAITING_LOCATION, { intent: 'TRAFFIC_STOP' }, { foo: 'bar' });

    const speaker = 'Chester-2';
    const speakerOwns = ownsInFlight(speaker);
    expect(speakerOwns).toBe(false);

    const indianaSessionAfter = getUnitSessionState('Indiana-1');
    expect(indianaSessionAfter.state).toBe(DISPATCHER_STATE.AWAITING_LOCATION);
    expect(indianaSessionAfter.slots.foo).toBe('bar');
  });

  it('returns true when speaker matches their own in-flight session', () => {
    setUnitSessionState('Indiana-1', DISPATCHER_STATE.AWAITING_PERSON_DETAILS, { intent: 'PERSON_CHECK' });
    expect(ownsInFlight('Indiana-1')).toBe(true);
  });
});
