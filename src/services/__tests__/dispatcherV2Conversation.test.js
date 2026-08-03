import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mapDispatcherV2PlanToLegacyResult,
  shouldUseDispatcherV2,
  validateDispatcherV2Plan,
} from '../dispatcherV2Planner.js';

describe('AI Dispatcher V2 conversational follow-up routing', () => {
  const originalFlag = process.env.AI_DISPATCHER_V2_ENABLED;

  beforeEach(() => {
    process.env.AI_DISPATCHER_V2_ENABLED = 'true';
  });

  afterEach(() => {
    if (originalFlag === undefined) delete process.env.AI_DISPATCHER_V2_ENABLED;
    else process.env.AI_DISPATCHER_V2_ENABLED = originalFlag;
  });

  it('keeps AI enabled while waiting for routine follow-up information', () => {
    expect(shouldUseDispatcherV2('AWAITING_CALL_ADDRESS')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_NATURE')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_CALL_CONFIRM')).toBe(true);
    expect(shouldUseDispatcherV2('AWAITING_NOTE_CONTENT')).toBe(true);
  });

  it('merges a newly supplied address with the pending call nature', () => {
    const plan = validateDispatcherV2Plan({
      action: 'CREATE_CALL',
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
      action: 'CREATE_CALL',
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
    const confirm = validateDispatcherV2Plan({ action: 'CONFIRM', confidence: 0.99, arguments: {} });
    const deny = validateDispatcherV2Plan({ action: 'DENY', confidence: 0.99, arguments: {} });
    expect(mapDispatcherV2PlanToLegacyResult(confirm, 'INDIANA-1')).toMatchObject({ intent: 'CONFIRM' });
    expect(mapDispatcherV2PlanToLegacyResult(deny, 'INDIANA-1')).toMatchObject({ intent: 'DENY' });
  });

  it('turns a free-form follow-up into a real call note', () => {
    const plan = validateDispatcherV2Plan({
      action: 'ADD_NOTE',
      confidence: 0.97,
      arguments: { noteContent: 'Rear loading door was found unsecured and has been secured.' },
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
});
