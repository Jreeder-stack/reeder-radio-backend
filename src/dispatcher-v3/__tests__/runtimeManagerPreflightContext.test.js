import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn(async () => ({ rows: [] }));
const preflightMock = vi.fn();
const startMock = vi.fn(async () => {});

vi.mock('../../db/index.js', () => ({
  default: { query: queryMock },
  getAiDispatchChannel: vi.fn(async () => null),
  getAllChannels: vi.fn(async () => []),
  isAiDispatchEnabled: vi.fn(async () => false),
  getStatusChecksEnabledState: vi.fn(async () => ({ enabled: true })),
}));

vi.mock('../../services/signalingService.js', () => ({
  signalingService: {
    onPttStart: vi.fn(() => () => {}),
    onPttEnd: vi.fn(() => () => {}),
    onEmergencyStart: vi.fn(() => () => {}),
    onEmergencyEnd: vi.fn(() => () => {}),
  },
}));

vi.mock('../../services/azureSpeechService.js', () => ({
  isConfigured: () => true,
}));

vi.mock('../../services/cadService.js', async () => {
  const { getRuntimeContext } = await import('../../services/runtimeContext.js');
  return {
    CORE_AI_DISPATCHER_CAD_SCOPES: ['call.read'],
    validateDispatcherCadIntegration: (...args) => preflightMock(getRuntimeContext(), ...args),
  };
});

vi.mock('../intentPlanner.js', () => ({
  isV3PlannerConfigured: () => true,
}));

vi.mock('../liveRuntime.js', () => ({
  V3LiveDispatcher: class {
    constructor({ runtimeContext }) {
      this.context = Object.freeze({ ...runtimeContext });
      this.connected = true;
      this.isRunning = true;
    }
    async start() { return startMock(); }
    async stop() {}
    matchesChannel() { return true; }
    getPipelineStatus() { return { runtime: 'v3' }; }
    async handlePttStart() {}
    async handlePttEnd() {}
    async handleEmergencyStart() {}
    async handleEmergencyEnd() {}
  },
}));

vi.mock('../../services/aiDispatchService.js', () => ({
  setActiveDispatcherCompatibility: vi.fn(),
}));

const { AIDispatcherRuntimeManager } = await import('../../services/aiDispatcherRuntimeManager.js');

describe('V3 runtime-manager CAD preflight context', () => {
  beforeEach(() => {
    queryMock.mockClear();
    preflightMock.mockReset();
    startMock.mockClear();
    process.env.CAD_URL = 'https://cad.example.test';
    process.env.CAD_API_KEY = 'secret';
  });

  it('runs readiness validation inside the selected dispatcher profile context', async () => {
    preflightMock.mockResolvedValue({ success: true, scopes: ['*'] });

    const manager = new AIDispatcherRuntimeManager();
    manager.ensureSchema = vi.fn(async () => {});
    manager.getProfileRow = vi.fn(async () => ({
      id: 'bulls-eye-ai',
      name: "Bull's Eye Security",
      enabled: true,
      channel_id: 42,
      channel_name: "Bull's Eye — DISPATCH",
      room_key: 'BULLS_EYE__DISPATCH',
      dispatch_center_id: 'besec',
      dispatch_center_name: "BULL'S EYE SECURITY",
      dispatch_center_code: 'besec',
      identity: 'AI-DISPATCHER:BULLSEYE',
      status_checks_enabled: false,
    }));

    await manager.startProfile('bulls-eye-ai');

    expect(preflightMock).toHaveBeenCalledTimes(1);
    const [runtimeContext, options] = preflightMock.mock.calls[0];
    expect(runtimeContext).toMatchObject({
      runtimeId: 'bulls-eye-ai',
      profileId: 'bulls-eye-ai',
      dispatchCenterId: 'besec',
      channelId: 42,
      roomKey: 'BULLS_EYE__DISPATCH',
      managed: true,
    });
    expect(options.requiredScopes).toContain('call.read');
    expect(startMock).toHaveBeenCalledTimes(1);
  });
});
