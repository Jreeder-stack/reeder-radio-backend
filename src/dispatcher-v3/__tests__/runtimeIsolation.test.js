import { describe, expect, it } from 'vitest';
import {
  DispatcherV3Error,
  buildV3RuntimeContext,
  runWithV3Runtime,
  getV3RuntimeContext,
  bindV3Runtime,
  assertV3ContextMatches,
  requireV3Scopes,
  createV3CorrelationId,
  childV3CorrelationId,
} from '../index.js';

function runtime(overrides = {}) {
  return {
    runtimeId: 'runtime-a',
    profileId: 'profile-a',
    dispatchCenterId: 'center-a',
    channelId: 12,
    roomKey: 'OPS__1',
    identity: 'AI-DISPATCHER:A',
    cadUrl: 'https://cad.example.test/',
    cadApiKey: 'secret',
    scopes: ['unit.read', 'unit.write'],
    ...overrides,
  };
}

describe('Dispatcher V3 runtime isolation', () => {
  it('normalizes CAD URL and scopes and freezes the context', () => {
    const context = buildV3RuntimeContext(runtime({ scopes: ['unit.read', 'unit.read', 'call.read'] }));
    expect(context.cadUrl).toBe('https://cad.example.test');
    expect(context.scopes).toEqual(['unit.read', 'call.read']);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.scopes)).toBe(true);
  });

  it('fails closed without CAD credentials', () => {
    expect(() => buildV3RuntimeContext(runtime({ cadApiKey: null }))).toThrow(DispatcherV3Error);
  });

  it('keeps async callbacks inside the assigned runtime context', async () => {
    const context = buildV3RuntimeContext(runtime());
    const result = await runWithV3Runtime(context, async () => {
      await Promise.resolve();
      return getV3RuntimeContext();
    });
    expect(result.runtimeId).toBe('runtime-a');
    expect(result.dispatchCenterId).toBe('center-a');
  });

  it('binds event callbacks to the originating runtime', async () => {
    const context = buildV3RuntimeContext(runtime());
    const callback = bindV3Runtime(context, async () => getV3RuntimeContext());
    const result = await callback();
    expect(result.runtimeId).toBe('runtime-a');
    expect(result.roomKey).toBe('OPS__1');
  });

  it('rejects a dispatch-center mismatch', () => {
    const expected = buildV3RuntimeContext(runtime());
    const actual = buildV3RuntimeContext(runtime({ dispatchCenterId: 'center-b' }));
    expect(() => assertV3ContextMatches(expected, actual)).toThrow(/dispatch center context mismatch/i);
  });

  it('rejects a radio-channel mismatch', () => {
    const expected = buildV3RuntimeContext(runtime());
    const actual = buildV3RuntimeContext(runtime({ channelId: 99, roomKey: 'OPS__9' }));
    expect(() => assertV3ContextMatches(expected, actual)).toThrow(/radio channel context mismatch/i);
  });

  it('enforces required scopes and supports wildcard scope', () => {
    const scoped = buildV3RuntimeContext(runtime());
    expect(requireV3Scopes(scoped, ['unit.read'])).toBe(true);
    expect(() => requireV3Scopes(scoped, ['call.write'])).toThrow(/missing required scope/i);

    const wildcard = buildV3RuntimeContext(runtime({ scopes: ['*'] }));
    expect(requireV3Scopes(wildcard, ['call.write', 'query.read'])).toBe(true);
  });

  it('creates stable parent-child correlation chains', () => {
    const parent = createV3CorrelationId('runtime-a');
    const child = childV3CorrelationId(parent, 'cad');
    expect(parent).toContain('v3-runtime-a-');
    expect(child.startsWith(`${parent}.cad.`)).toBe(true);
  });
});
