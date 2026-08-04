// Contextual CAD tool-planning regression coverage.
import { describe, expect, it } from 'vitest';
import {
  containsProtectedEmergencyTraffic,
  mapDispatcherV2PlanToLegacyResult,
  resolveContextualToolArguments,
  validateDispatcherV2Plan,
} from './dispatcherV2Planner.js';

describe('AI Dispatcher V2 contextual tool planner', () => {
  it('keeps backwards compatibility for a valid status change', () => {
    const plan = validateDispatcherV2Plan({
      action: 'STATUS_CHANGE',
      confidence: 0.97,
      arguments: { status: 'en route' },
      spokenResponse: 'Copy, en route.',
    });

    expect(plan).not.toBeNull();
    expect(plan.tool).toBe('update_unit_status');
    expect(mapDispatcherV2PlanToLegacyResult(plan, 'INDIANA-1')).toMatchObject({
      intent: 'STATUS_CHANGE',
      cadStatus: 'en_route',
      response: 'Copy, en route.',
    });
  });

  it('asks only for the missing call location', () => {
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'create_call',
      confidence: 0.95,
      arguments: { nature: 'Domestic disturbance' },
    });

    expect(mapDispatcherV2PlanToLegacyResult(plan, 'INDIANA-1')).toMatchObject({
      intent: 'CREATE_CALL_PROMPT',
      response: 'What is the location?',
      slots: { nature: 'Domestic disturbance' },
    });
  });

  it('rejects an unknown tool or unsupported legacy action', () => {
    expect(validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'dispatch_wrecker',
      confidence: 0.99,
      arguments: {},
    })).toBeNull();

    expect(validateDispatcherV2Plan({
      action: 'DISPATCH_WRECKER',
      confidence: 0.99,
      arguments: {},
    })).toBeNull();
  });

  it('rejects low-confidence write tools', () => {
    expect(validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'clear_unit',
      confidence: 0.51,
      arguments: {},
    })).toBeNull();
  });

  it('normalizes plate and state arguments', () => {
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'run_plate',
      confidence: 0.96,
      arguments: { plate: 'abc-1234', state: 'Pennsylvania' },
    });

    expect(mapDispatcherV2PlanToLegacyResult(plan, 'INDIANA-1')).toMatchObject({
      intent: 'RUN_PLATE',
      slots: { plate: 'ABC1234', state: 'PA' },
    });
  });

  it('resolves another-unit assignment from the most recent created call', () => {
    const operationalContext = {
      activeCalls: [{ callId: 'uuid-1', callNumber: '2026-00123', nature: 'BUILDING CHECK', location: 'Fayette County Fair' }],
      recentActions: [{ type: 'CREATE_CALL', callId: 'uuid-1', callNumber: '2026-00123', ageSeconds: 4 }],
      currentCall: null,
    };
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'assign_unit_to_call',
      confidence: 0.99,
      arguments: { unitId: '2301', callReference: 'recent' },
    }, { unitId: 'REEDER', operationalContext });

    expect(plan.arguments.callNumber).toBe('2026-00123');
    expect(mapDispatcherV2PlanToLegacyResult(plan, 'REEDER')).toMatchObject({
      intent: 'ASSIGN_OTHER_UNIT',
      slots: { targetUnit: '2301', callNumber: '2026-00123' },
    });
  });

  it('resolves a uniquely described active call without a canned phrase', () => {
    const args = resolveContextualToolArguments('assign_unit_to_call', {
      unitId: '2301',
      callNature: 'building check',
      callLocation: 'Fayette County Fair',
    }, {
      activeCalls: [
        { callId: 'uuid-1', callNumber: '2026-00123', nature: 'BUILDING CHECK', location: 'Fayette County Fair' },
        { callId: 'uuid-2', callNumber: '2026-00124', nature: 'ALARM', location: 'Main Street' },
      ],
      recentActions: [],
    });

    expect(args.callNumber).toBe('2026-00123');
  });

  it('keeps explicit emergency phrases out of the routine planner', () => {
    expect(containsProtectedEmergencyTraffic('Central, officer down')).toBe(true);
    expect(containsProtectedEmergencyTraffic('Central, show me en route')).toBe(false);
  });
});
