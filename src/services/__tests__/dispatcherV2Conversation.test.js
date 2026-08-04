import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mapDispatcherV2PlanToLegacyResult,
  shouldUseDispatcherV2,
  validateDispatcherV2Plan,
} from '../dispatcherV2Planner.js';

describe('AI Dispatcher V2 conversational tool routing', () => {
  const originalFlag = process.env.AI_DISPATCHER_V2_ENABLED;

  beforeEach(() => {
    process.env.AI_DISPATCHER_V2_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AI_DISPATCHER_V2_ENABLED;
    else process.env.AI_DISPATCHER_V2_ENABLED = originalFlag;
  });

  it('keeps AI enabled through routine multi-turn call workflows', () => {
    expect(shouldUseDispatcherV2('AWAITING_CALL_ADDRESS')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_NATURE')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_CONFIRM')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_NOTE_CONTENT')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_FOLLOWUP')).toBe(true);
  });

  it('merges a newly supplied address with the pending call nature', () => {
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'create_call',
      confidence: 0.98,
      arguments: { address: 'Fayette County Fair, Dunbar, PA' },
    });
    const result = mapDispatcherV2PlanToLegacyResult(
      plan,
      'INDIANA-1',
      'AWAITING_CALL_ADDRESS',
      { nature: 'BUILDING CHECK', priority: 'medium', additionalUnits: [] },
    );
    expect(result).toMatchObject({
      intent: 'CREATE_CALL',
      slots: {
        nature: 'BUILDING CHECK',
        address: 'Fayette County Fair, Dunbar, PA',
        priority: 'medium',
      },
    });
  });

  it('merges a newly supplied nature with the pending address', () => {
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'create_call',
      confidence: 0.98,
      arguments: { nature: 'building check' },
    });
    const result = mapDispatcherV2PlanToLegacyResult(
      plan,
      'INDIANA-1',
      'AWAITING_CALL_NATURE',
      { address: '132 Pechin Road, Dunbar, PA', priority: 'medium' },
    );
    expect(result).toMatchObject({
      intent: 'CREATE_CALL',
      slots: {
        nature: 'building check',
        address: '132 Pechin Road, Dunbar, PA',
      },
    });
  });

  it('maps natural confirmation decisions back to guarded handlers', () => {
    const confirm = validateDispatcherV2Plan({ decision: 'CONFIRM', confidence: 0.99, arguments: {} });
    const deny = validateDispatcherV2Plan({ decision: 'DENY', confidence: 0.99, arguments: {} });
    expect(mapDispatcherV2PlanToLegacyResult(confirm, 'INDIANA-1')).toMatchObject({ intent: 'CONFIRM' });
    expect(mapDispatcherV2PlanToLegacyResult(deny, 'INDIANA-1')).toMatchObject({ intent: 'DENY' });
  });

  it('turns a free-form follow-up into a real call note tool', () => {
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'add_call_note',
      confidence: 0.97,
      arguments: { note: 'Rear loading door was found unsecured and has been secured.' },
    });
    expect(mapDispatcherV2PlanToLegacyResult(
      plan,
      'INDIANA-1',
      'AWAITING_NOTE_CONTENT',
      {},
    )).toMatchObject({
      intent: 'ADD_NOTE',
      slots: { noteContent: 'Rear loading door was found unsecured and has been secured.' },
    });
  });

  it('maps "add another unit to that call" to the other-unit handler with a resolved call', () => {
    const plan = validateDispatcherV2Plan({
      decision: 'USE_TOOL',
      tool: 'assign_unit_to_call',
      confidence: 0.99,
      arguments: { unitId: 'SECURITY-2', callReference: 'last_created' },
    }, {
      unitId: 'SECURITY-1',
      operationalContext: {
        currentCall: null,
        activeCalls: [{ callId: 'call-77', callNumber: 'S-2026-77', nature: 'BUILDING CHECK' }],
        recentActions: [{ type: 'CREATE_CALL', callId: 'call-77', callNumber: 'S-2026-77', ageSeconds: 3 }],
      },
    });

    expect(mapDispatcherV2PlanToLegacyResult(plan, 'SECURITY-1')).toMatchObject({
      intent: 'ASSIGN_OTHER_UNIT',
      slots: { targetUnit: 'SECURITY-2', callNumber: 'S-2026-77' },
    });
  });
});
