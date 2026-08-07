import { describe, expect, it } from 'vitest';
import {
  DISPATCHER_RUNTIME,
  DispatcherV3Error,
  V3_ERROR_CODES,
  buildV3RuntimeContext,
  getConfiguredDispatcherRuntime,
} from '../index.js';

const base = {
  runtimeId: 'runtime-1',
  profileId: 'profile-1',
  dispatchCenterId: 'center-1',
  channelId: 7,
  roomKey: 'OPS__1',
  identity: 'AI-DISPATCHER:TEST',
  cadUrl: 'https://cad.example.test',
  cadApiKey: 'secret',
};

describe('dispatcher-v3 foundation', () => {
  it('defaults to V3 with explicit legacy rollback available', () => {
    expect(getConfiguredDispatcherRuntime({})).toBe(DISPATCHER_RUNTIME.V3);
    expect(getConfiguredDispatcherRuntime({ AI_DISPATCHER_RUNTIME: 'v3' })).toBe(DISPATCHER_RUNTIME.V3);
    expect(getConfiguredDispatcherRuntime({ AI_DISPATCHER_RUNTIME: 'legacy' })).toBe(DISPATCHER_RUNTIME.LEGACY);
  });

  it('builds and freezes a valid runtime context', () => {
    const context = buildV3RuntimeContext(base);
    expect(context.dispatchCenterId).toBe('center-1');
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('fails closed when a dispatch center is missing', () => {
    expect(() => buildV3RuntimeContext({ ...base, dispatchCenterId: null })).toThrowError(DispatcherV3Error);
    try {
      buildV3RuntimeContext({ ...base, dispatchCenterId: null });
    } catch (error) {
      expect(error.code).toBe(V3_ERROR_CODES.DISPATCH_CENTER_REQUIRED);
    }
  });
});
