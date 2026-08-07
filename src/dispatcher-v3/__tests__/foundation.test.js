import { describe, expect, it } from 'vitest';
import {
  DISPATCHER_RUNTIME,
  DispatcherV3Error,
  V3_ERROR_CODES,
  buildV3RuntimeContext,
  getConfiguredDispatcherRuntime,
} from '../index.js';

describe('dispatcher-v3 foundation', () => {
  it('defaults to the legacy runtime until V3 is explicitly selected', () => {
    expect(getConfiguredDispatcherRuntime({})).toBe(DISPATCHER_RUNTIME.LEGACY);
    expect(getConfiguredDispatcherRuntime({ AI_DISPATCHER_RUNTIME: 'v3' })).toBe(DISPATCHER_RUNTIME.V3);
  });

  it('builds and freezes a valid runtime context', () => {
    const context = buildV3RuntimeContext({
      runtimeId: 'runtime-1',
      profileId: 'profile-1',
      dispatchCenterId: 'center-1',
      channelId: 7,
      roomKey: 'OPS__1',
      identity: 'AI-DISPATCHER:TEST',
    });

    expect(context.dispatchCenterId).toBe('center-1');
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('fails closed when a dispatch center is missing', () => {
    expect(() => buildV3RuntimeContext({
      runtimeId: 'runtime-1',
      profileId: 'profile-1',
      channelId: 7,
      roomKey: 'OPS__1',
      identity: 'AI-DISPATCHER:TEST',
    })).toThrowError(DispatcherV3Error);

    try {
      buildV3RuntimeContext({
        runtimeId: 'runtime-1',
        profileId: 'profile-1',
        channelId: 7,
        roomKey: 'OPS__1',
        identity: 'AI-DISPATCHER:TEST',
      });
    } catch (error) {
      expect(error.code).toBe(V3_ERROR_CODES.DISPATCH_CENTER_REQUIRED);
    }
  });
});
