import { describe, expect, it, vi } from 'vitest';
import { buildV3RuntimeContext } from '../runtimeContract.js';
import { runWithV3Runtime, getV3RuntimeContext } from '../runtimeStore.js';
import { V3ActionExecutor } from '../actionExecutor.js';
import { V3DiagnosticsJournal } from '../diagnostics.js';
import { UnitIdentityService } from '../unitIdentity.js';

function runtime(overrides = {}) {
  return buildV3RuntimeContext({
    runtimeId: 'runtime-a',
    profileId: 'profile-a',
    profileName: 'Dispatcher A',
    dispatchCenterId: 'center-a',
    dispatchCenterName: 'Center A',
    agencyId: 'agency-a',
    channelId: '10',
    channelName: 'OPS 1',
    roomKey: 'Zone1__OPS1',
    identity: 'central-a',
    cadUrl: 'https://cad.example.test',
    cadApiKey: 'secret',
    scopes: ['unit.read', 'unit.write', 'call.read', 'call.write'],
    ...overrides,
  });
}

describe('AI Dispatcher V3 phase 3 regression matrix', () => {
  it('fails closed when dispatch center is missing', () => {
    expect(() => runtime({ dispatchCenterId: null })).toThrowError(expect.objectContaining({ code: 'DISPATCH_CENTER_REQUIRED' }));
  });

  it('fails closed when channel context is missing', () => {
    expect(() => runtime({ channelId: null })).toThrowError(expect.objectContaining({ code: 'CHANNEL_REQUIRED' }));
  });

  it('keeps simultaneous runtime contexts isolated', async () => {
    const a = runtime();
    const b = runtime({
      runtimeId: 'runtime-b',
      profileId: 'profile-b',
      dispatchCenterId: 'center-b',
      channelId: '20',
      roomKey: 'Zone2__SECURE',
      identity: 'central-b',
    });

    const [seenA, seenB] = await Promise.all([
      runWithV3Runtime(a, async () => {
        await Promise.resolve();
        return getV3RuntimeContext();
      }),
      runWithV3Runtime(b, async () => {
        await Promise.resolve();
        return getV3RuntimeContext();
      }),
    ]);

    expect(seenA.runtimeId).toBe('runtime-a');
    expect(seenA.dispatchCenterId).toBe('center-a');
    expect(seenB.runtimeId).toBe('runtime-b');
    expect(seenB.dispatchCenterId).toBe('center-b');
  });

  it('blocks an action when its required scope is missing', async () => {
    const handler = vi.fn();
    const executor = new V3ActionExecutor({
      runtimeContext: runtime({ scopes: ['unit.read'] }),
      handlers: { SET_UNIT_STATUS: handler },
    });
    const result = await executor.execute({
      action: 'SET_UNIT_STATUS',
      input: { unitId: 'unit-uuid', status: 'available' },
    });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('UNAUTHORIZED');
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects malformed AI/planner output before any handler runs', async () => {
    const handler = vi.fn();
    const executor = new V3ActionExecutor({
      runtimeContext: runtime(),
      handlers: { CREATE_CALL: handler },
    });
    const result = await executor.execute({
      action: 'CREATE_CALL',
      input: { type: 'BUILDING CHECK', location: '', unitIds: [] },
    });
    expect(result.success).toBe(false);
    expect(result.error.code).toBe('INVALID_ACTION_INPUT');
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates CAD failures without reporting action success', async () => {
    const executor = new V3ActionExecutor({
      runtimeContext: runtime(),
      handlers: {
        RADIO_CHECK: async () => {
          const error = new Error('CAD unavailable');
          error.code = 'network';
          throw error;
        },
      },
    });
    const result = await executor.execute({ action: 'RADIO_CHECK', input: {} });
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
  });

  it('keeps diagnostic traces separated by runtime and correlation ID', async () => {
    const journal = new V3DiagnosticsJournal({ logger: null });
    const execA = new V3ActionExecutor({ runtimeContext: runtime(), diagnostics: journal, handlers: { RADIO_CHECK: async () => ({ ok: true }) } });
    const execB = new V3ActionExecutor({ runtimeContext: runtime({ runtimeId: 'runtime-b', profileId: 'profile-b', dispatchCenterId: 'center-b', channelId: '20', roomKey: 'Zone2__SECURE', identity: 'central-b' }), diagnostics: journal, handlers: { RADIO_CHECK: async () => ({ ok: true }) } });

    await Promise.all([
      execA.execute({ action: 'RADIO_CHECK', input: {} }, { correlationId: 'corr-a' }),
      execB.execute({ action: 'RADIO_CHECK', input: {} }, { correlationId: 'corr-b' }),
    ]);

    expect(journal.getRecent({ runtimeId: 'runtime-a' }).every((entry) => entry.correlationId === 'corr-a')).toBe(true);
    expect(journal.getRecent({ runtimeId: 'runtime-b' }).every((entry) => entry.correlationId === 'corr-b')).toBe(true);
  });

  it('refuses a malformed successful unit-resolution response', async () => {
    const gateway = { request: vi.fn(async () => ({ success: true, unit: { callsign: 'INDIANA-1' } })) };
    const service = new UnitIdentityService({ gateway, runtimeContext: runtime() });
    await expect(service.resolve('INDIANA-1', { correlationId: 'identity-bad' }))
      .rejects.toMatchObject({ code: 'CAD_REJECTED' });
  });
});
