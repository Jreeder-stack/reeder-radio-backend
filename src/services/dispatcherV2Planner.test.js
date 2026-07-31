import { describe, expect, it } from 'vitest';
import {
  containsProtectedEmergencyTraffic,
  mapDispatcherV2PlanToLegacyResult,
  validateDispatcherV2Plan,
} from './dispatcherV2Planner.js';

describe('AI Dispatcher V2 planner validation', () => {
  it('maps a valid status change without phrase matching', () => {
    const plan = validateDispatcherV2Plan({
      action: 'STATUS_CHANGE',
      confidence: 0.97,
      arguments: { status: 'en route' },
      spokenResponse: 'Copy, en route.',
    });

    expect(plan).not.toBeNull();
    expect(mapDispatcherV2PlanToLegacyResult(plan, 'INDIANA-1')).toMatchObject({
      intent: 'STATUS_CHANGE',
      cadStatus: 'en_route',
      response: 'Copy, en route.',
    });
  });

  it('asks only for the missing call location', () => {
    const plan = validateDispatcherV2Plan({
      action: 'CREATE_CALL',
      confidence: 0.95,
      arguments: { nature: 'Domestic disturbance' },
    });

    expect(mapDispatcherV2PlanToLegacyResult(plan, 'INDIANA-1')).toMatchObject({
      intent: 'CREATE_CALL_PROMPT',
      response: 'What is the location?',
      slots: { nature: 'Domestic disturbance' },
    });
  });

  it('rejects an unsupported action even at high confidence', () => {
    expect(validateDispatcherV2Plan({
      action: 'DISPATCH_WRECKER',
      confidence: 0.99,
      arguments: {},
    })).toBeNull();
  });

  it('rejects low-confidence write actions', () => {
    expect(validateDispatcherV2Plan({
      action: 'CLEAR_UNIT',
      confidence: 0.51,
      arguments: {},
    })).toBeNull();
  });

  it('normalizes plate and state arguments', () => {
    const plan = validateDispatcherV2Plan({
      action: 'RUN_PLATE',
      confidence: 0.96,
      arguments: { plate: 'abc-1234', state: 'Pennsylvania' },
    });

    expect(mapDispatcherV2PlanToLegacyResult(plan, 'INDIANA-1')).toMatchObject({
      intent: 'RUN_PLATE',
      slots: { plate: 'ABC1234', state: 'PA' },
    });
  });

  it('keeps explicit emergency phrases out of the routine planner', () => {
    expect(containsProtectedEmergencyTraffic('Central, officer down')).toBe(true);
    expect(containsProtectedEmergencyTraffic('Central, show me en route')).toBe(false);
  });
});
