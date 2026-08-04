import { describe, expect, it } from 'vitest';
import {
  getDispatcherTool,
  listDispatcherTools,
  validateDispatcherToolArguments,
} from '../dispatcherToolRegistry.js';
import {
  compareShadowPlan,
  containsSafetyCriticalTraffic,
  mapExistingIntentToTool,
  validateShadowToolPlan,
} from '../dispatcherToolPlanner.js';

describe('dispatcher tool registry safety', () => {
  it('contains declarative definitions and no executable handlers', () => {
    const tools = listDispatcherTools();
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.shadowOnly).toBeUndefined();
      expect(tool.execute).toBeUndefined();
      expect(tool.name).toBeTruthy();
      expect(tool.risk).toBeTruthy();
    }
  });

  it('validates required fields without executing anything', () => {
    const missing = validateDispatcherToolArguments('create_call', { nature: 'disturbance' });
    expect(missing.valid).toBe(false);
    expect(missing.missingFields).toContain('address');

    const complete = validateDispatcherToolArguments('update_unit_status', {
      unitId: 'indiana 1',
      status: 'en route',
    });
    expect(complete.valid).toBe(true);
    expect(complete.arguments).toEqual({ unitId: 'INDIANA-1', status: 'en_route' });
  });

  it('exposes high-impact confirmation metadata', () => {
    expect(getDispatcherTool('close_call').confirmationRequired).toBe(true);
    expect(getDispatcherTool('cancel_call').risk).toBe('high_impact_write');
  });

  it('allows contextual call references for another-unit assignments', () => {
    const complete = validateDispatcherToolArguments('assign_unit_to_call', {
      unitId: 'security 2',
      callReference: 'last created',
    });
    expect(complete.valid).toBe(true);
    expect(complete.arguments).toMatchObject({
      unitId: 'SECURITY-2',
      callReference: 'last_created',
    });
  });
});

describe('dispatcher tool planner shadow comparison', () => {
  it('maps existing dispatcher intents to comparable tools', () => {
    expect(mapExistingIntentToTool({ intent: 'STATUS_CHANGE' })).toBe('update_unit_status');
    expect(mapExistingIntentToTool({ intent: 'CREATE_CALL' })).toBe('create_call');
    expect(mapExistingIntentToTool({ intent: 'UNKNOWN' })).toBeNull();
  });

  it('accepts a complete routine plan and injects the speaking unit', () => {
    const plan = validateShadowToolPlan({
      tool: 'update_unit_status',
      arguments: { status: 'en route' },
      confidence: 0.94,
      missingFields: [],
      needsClarification: false,
      reason: 'Unit reports responding.',
    }, { unitId: 'INDIANA-1', minConfidence: 0.70 });

    expect(plan).toMatchObject({
      tool: 'update_unit_status',
      arguments: { unitId: 'INDIANA-1', status: 'en_route' },
      executable: false,
      shadowOnly: true,
    });
  });

  it('allows an incomplete shadow tool only with a clarification question', () => {
    const plan = validateShadowToolPlan({
      tool: 'create_call',
      arguments: { nature: 'disturbance' },
      confidence: 0.91,
      missingFields: ['address'],
      needsClarification: true,
      clarificationQuestion: 'Go ahead with the address.',
      reason: 'Call nature is clear but location is missing.',
    }, { unitId: 'INDIANA-1', minConfidence: 0.70 });

    expect(plan.missingFields).toContain('address');
    expect(plan.needsClarification).toBe(true);
    expect(plan.executable).toBe(false);
  });

  it('rejects unknown, low-confidence, and invalid shadow plans', () => {
    expect(validateShadowToolPlan({
      tool: 'delete_everything', arguments: {}, confidence: 0.99,
    }, { minConfidence: 0.70 })).toBeNull();

    expect(validateShadowToolPlan({
      tool: 'radio_check', arguments: {}, confidence: 0.40,
    }, { minConfidence: 0.70 })).toBeNull();

    expect(validateShadowToolPlan({
      tool: 'create_call', arguments: { nature: 'alarm' }, confidence: 0.95,
      needsClarification: true, missingFields: ['address'], clarificationQuestion: null,
    }, { minConfidence: 0.70 })).toBeNull();
  });

  it('reports agreement and disagreement without changing behavior', () => {
    expect(compareShadowPlan(
      { intent: 'STATUS_CHANGE' },
      { tool: 'update_unit_status' },
    )).toMatchObject({ outcome: 'agreement' });

    expect(compareShadowPlan(
      { intent: 'STATUS_CHANGE' },
      { tool: 'create_call' },
    )).toMatchObject({ outcome: 'disagreement' });
  });

  it('skips safety-critical traffic', () => {
    expect(containsSafetyCriticalTraffic('Central, shots fired, officer needs help')).toBe(true);
    expect(containsSafetyCriticalTraffic('Show me en route to the detail')).toBe(false);
  });
});
