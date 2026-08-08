import { describe, expect, it } from 'vitest';
import {
  V3_ACTIONS,
  V3_ERROR_CODES,
  V3_UNIT_STATUSES,
  listV3Actions,
  validateV3ActionRequest,
} from '../index.js';

const context = {
  scopes: ['unit.read', 'unit.write', 'call.read', 'call.write'],
};

describe('Dispatcher V3 action contracts', () => {
  it('publishes the first supported action set', () => {
    expect(listV3Actions()).toEqual(expect.arrayContaining(Object.values(V3_ACTIONS)));
    expect(listV3Actions()).toHaveLength(Object.keys(V3_ACTIONS).length);
  });

  it('normalizes and freezes a valid status action', () => {
    const result = validateV3ActionRequest({
      action: 'set_unit_status',
      input: { unitId: 'unit-uuid-1', status: 'EN_ROUTE' },
    }, context);

    expect(result.action).toBe(V3_ACTIONS.SET_UNIT_STATUS);
    expect(result.input).toEqual({ unitId: 'unit-uuid-1', status: 'en_route', note: null });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.input)).toBe(true);
  });

  it('rejects unknown actions', () => {
    expect(() => validateV3ActionRequest({ action: 'MAKE_UP_A_COMMAND' }, context))
      .toThrowError(expect.objectContaining({ code: V3_ERROR_CODES.INVALID_ACTION }));
  });

  it('rejects unsupported statuses', () => {
    expect(V3_UNIT_STATUSES).not.toContain('responding');
    expect(() => validateV3ActionRequest({
      action: V3_ACTIONS.SET_UNIT_STATUS,
      input: { unitId: 'unit-uuid-1', status: 'responding' },
    }, context)).toThrowError(expect.objectContaining({ code: V3_ERROR_CODES.INVALID_ACTION_INPUT }));
  });

  it('requires immutable unit IDs for executable unit actions', () => {
    expect(() => validateV3ActionRequest({
      action: V3_ACTIONS.SET_UNIT_STATUS,
      input: { callsign: 'INDIANA-1', status: 'en_route' },
    }, context)).toThrowError(expect.objectContaining({ code: V3_ERROR_CODES.INVALID_ACTION_INPUT }));
  });

  it('allows zero resolved units for an unassigned call', () => {
    const result = validateV3ActionRequest({
      action: V3_ACTIONS.CREATE_CALL,
      input: { type: 'Building Check', location: '100 Main St', unitIds: [] },
    }, context);
    expect(result.input.unitIds).toEqual([]);
  });

  it('deduplicates resolved unit IDs for call creation', () => {
    const result = validateV3ActionRequest({
      action: V3_ACTIONS.CREATE_CALL,
      input: {
        type: 'Building Check',
        location: '100 Main St',
        unitIds: ['unit-1', 'unit-1', 'unit-2'],
      },
    }, context);
    expect(result.input.unitIds).toEqual(['unit-1', 'unit-2']);
  });

  it('enforces action scopes before execution', () => {
    expect(() => validateV3ActionRequest({
      action: V3_ACTIONS.CREATE_CALL,
      input: { type: 'Building Check', location: '100 Main St', unitIds: ['unit-1'] },
    }, { scopes: ['unit.read'] })).toThrowError(expect.objectContaining({ code: V3_ERROR_CODES.UNAUTHORIZED }));
  });

  it('requires disposition to close a call', () => {
    expect(() => validateV3ActionRequest({
      action: V3_ACTIONS.CLOSE_CALL,
      input: { callId: 'call-1' },
    }, context)).toThrowError(expect.objectContaining({ code: V3_ERROR_CODES.INVALID_ACTION_INPUT }));
  });
});
