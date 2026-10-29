import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  profiles: [], accounts: [], grants: new Map(),
  callbacks: { start: [], end: [], emergencyStart: [], emergencyEnd: [] },
}));

const query = vi.hoisted(() => vi.fn(async (sql, values = []) => {
  if (sql.includes('SELECT sess FROM session')) {
    const account = fixture.accounts.find((item) => `session-${item.id}` === values[0]);
    return { rows: account ? [{ sess: { user: { id: account.id } } }] : [] };
  }
  if (sql.includes('FROM users WHERE id = $1')) {
    return { rows: fixture.accounts.filter((account) => account.id === values[0] && account.status === 'active') };
  }
  if (sql.includes('FROM user_channel_access')) return { rows: fixture.grants.get(values[0]) || [] };
  if (sql.includes('SELECT * FROM ai_dispatcher_profiles WHERE')) {
    return { rows: fixture.profiles.filter((profile) => profile.id === values[0]) };
  }
  if (sql.includes('SELECT * FROM ai_dispatcher_profiles ORDER')) return { rows: fixture.profiles.map((profile) => ({ ...profile })) };
  if (sql.includes('INSERT INTO ai_dispatcher_profiles')) {
    const row = {
      id: values[0], name: values[1], enabled: values[2], channel_id: values[3], channel_name: values[4],
      room_key: values[5], dispatch_center_id: values[6], identity: values[10], status_checks_enabled: values[11],
    };
    fixture.profiles.push(row);
    return { rows: [{ ...row }] };
  }
  if (sql.includes('UPDATE ai_dispatcher_profiles SET') && sql.includes('name=$2')) {
    const row = fixture.profiles.find((item) => item.id === values[0]);
    Object.assign(row, { name: values[1], enabled: values[2], channel_id: values[3], channel_name: values[4],
      room_key: values[5], dispatch_center_id: values[6], status_checks_enabled: values[9] });
    return { rows: [{ ...row }] };
  }
  if (sql.includes('DELETE FROM ai_dispatcher_profiles')) {
    const before = fixture.profiles.length;
    fixture.profiles = fixture.profiles.filter((item) => item.id !== values[0]);
    return { rows: fixture.profiles.length < before ? [{ id: values[0] }] : [] };
  }
  if (sql.includes('UPDATE ai_dispatcher_profiles')) return { rows: [] };
  throw new Error(`Unexpected fixture query: ${sql}`);
}));

vi.mock('../../db/index.js', () => ({
  default: { query }, getRadioByToken: vi.fn(async () => null),
  getAiDispatchChannel: vi.fn(async () => null), getAllChannels: vi.fn(async () => []),
  isAiDispatchEnabled: vi.fn(async () => true), getStatusChecksEnabledState: vi.fn(async () => ({ enabled: false })),
}));
vi.mock('../signalingService.js', () => {
  const subscribe = (event) => (callback) => {
    fixture.callbacks[event].push(callback);
    return () => { fixture.callbacks[event] = fixture.callbacks[event].filter((item) => item !== callback); };
  };
  return { signalingService: {
    onPttStart: subscribe('start'), onPttEnd: subscribe('end'),
    onEmergencyStart: subscribe('emergencyStart'), onEmergencyEnd: subscribe('emergencyEnd'),
  } };
});
vi.mock('../azureSpeechService.js', () => ({ isConfigured: () => true }));
vi.mock('../cadService.js', () => ({
  CORE_AI_DISPATCHER_CAD_SCOPES: ['unit.read', 'unit.write'],
  validateDispatcherCadIntegration: vi.fn(async () => ({ success: true, scopes: ['unit.read', 'unit.write'] })),
}));
vi.mock('../../dispatcher-v3/intentPlanner.js', () => ({ isV3PlannerConfigured: () => true }));
vi.mock('../../dispatcher-v3/liveRuntime.js', () => ({
  V3LiveDispatcher: class {
    constructor({ runtimeContext }) {
      this.context = Object.freeze({ ...runtimeContext });
      this.start = vi.fn(async () => { this.isRunning = true; this.connected = true; });
      this.stop = vi.fn(async () => { this.isRunning = false; this.connected = false; });
      this.handlePttStart = vi.fn(async () => true);
      this.handlePttEnd = vi.fn(async () => true);
      this.handleEmergencyStart = vi.fn(async () => true);
      this.handleEmergencyEnd = vi.fn(async () => true);
    }
    matchesChannel(channel) {
      return [this.context.channelId, this.context.roomKey, this.context.channelName].map(String).includes(String(channel));
    }
    getPipelineStatus() { return { runtime: 'v3' }; }
  },
}));

import { AIDispatcherRuntimeManager } from '../aiDispatcherRuntimeManager.js';
import { aiDispatcherSignaling } from '../aiDispatcherSignaling.js';
import { getDispatcher, setActiveDispatcherCompatibility, setDispatcherPttCompatibilityResolver } from '../aiDispatchService.js';
import {
  attachPttMetadata, createPttTransmission, finishPttTransmission,
  isTrustedPttTransmission, loadSessionPttPrincipal, samePttTransmission,
} from '../pttProvenance.js';

const profile = (center = 'a', channel = 41, options = {}) => ({
  id: `profile-${center}`, name: `Center ${center}`, enabled: true,
  channel_id: channel, channel_name: 'OPS1', room_key: `${center}__OPS1`,
  dispatch_center_id: `center-${center}`, identity: `AI:${center}`, status_checks_enabled: false,
  ...options,
});
const account = (id = 'account-a') => ({ id, username: id, unit_id: 'A1', status: 'active' });
const grant = (row) => ({ channel_id: row.channel_id, channel_name: row.channel_name, room_key: row.room_key });

let manager;
async function start(rows = [profile()]) {
  fixture.profiles = rows;
  manager = new AIDispatcherRuntimeManager();
  manager.ensureSchema = vi.fn(async () => {});
  for (const row of rows.filter((item) => item.enabled)) await manager.startProfile(row.id);
  return manager;
}
async function transmission(row = fixture.profiles[0], accountId = 'account-a') {
  if (!fixture.accounts.some((item) => item.id === accountId)) fixture.accounts.push(account(accountId));
  fixture.grants.set(accountId, [grant(row)]);
  const principal = await loadSessionPttPrincipal(`session-${accountId}`, { connectionId: `socket-${accountId}` });
  return createPttTransmission(principal, { channelId: row.room_key, source: 'signaling', captureStartedAt: 1000 });
}
async function emit(event, data, metadata) {
  return Promise.all(fixture.callbacks[event].map((callback) => callback(data, metadata)));
}

beforeEach(() => {
  fixture.profiles = []; fixture.accounts = []; fixture.grants.clear();
  Object.keys(fixture.callbacks).forEach((event) => { fixture.callbacks[event] = []; });
  query.mockClear();
  setActiveDispatcherCompatibility(null);
  setDispatcherPttCompatibilityResolver(null);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  process.env.CAD_URL = 'https://cad.example.test';
  process.env.CAD_API_KEY = 'synthetic';
  manager = null;
});
afterEach(async () => {
  if (manager) await manager.shutdown();
  setDispatcherPttCompatibilityResolver(null);
  vi.restoreAllMocks();
});

describe('01-02 configured channel/center binding', () => {
  it.each(['41', 'a__OPS1', 'OPS1'])('binds a proved account grant using unambiguous %s', async (channel) => {
    await start();
    const metadata = await transmission();
    const route = manager.resolvePttDispatcher(channel, metadata);
    expect(route.dispatcher).toBe(manager.runtimes.get('profile-a').dispatcher);
    expect(route.transmission.binding).toEqual({ channelId: '41', roomKey: 'a__OPS1', dispatchCenterId: 'center-a', profileId: 'profile-a' });
    expect(route.transmission.principal).toBe(metadata.principal);
    expect(isTrustedPttTransmission(route.transmission)).toBe(true);
    expect(samePttTransmission(route.transmission, metadata)).toBe(true);
    expect(Object.isFrozen(route.transmission)).toBe(true);
    expect(Object.isFrozen(route.transmission.binding)).toBe(true);
    expect(manager.resolvePttDispatcher(channel, metadata).transmission).toBe(route.transmission);
  });

  it.each([null, {}, { authenticated: true, channelId: '41', unitId: 'A1' }])('rejects unproved metadata %#', async (metadata) => {
    await start();
    expect(manager.resolvePttDispatcher('a__OPS1', metadata)).toBeNull();
  });

  it('rejects serialized provenance even when every JSON field is copied', async () => {
    await start();
    const metadata = await transmission();
    expect(manager.resolvePttDispatcher('a__OPS1', JSON.parse(JSON.stringify(metadata)))).toBeNull();
  });

  it('does not infer configuration ownership from a running runtime alone', async () => {
    await start();
    const metadata = await transmission();
    manager._pttConfigurationLoaded = false;
    expect(manager.runtimes.size).toBe(1);
    expect(manager.resolvePttDispatcher('a__OPS1', metadata)).toBeNull();
  });

  it('rejects a channel mapped to two centers, including a disabled second profile', async () => {
    const a = profile();
    await start([a, profile('b', 41, { enabled: false, room_key: a.room_key })]);
    const metadata = await transmission(a);
    expect(manager.runtimes.size).toBe(1);
    expect(manager.resolvePttDispatcher(a.room_key, metadata)).toBeNull();
  });

  it('requires a matching room key as well as a granted channel ID', async () => {
    await start();
    const metadata = await transmission({ ...fixture.profiles[0], room_key: 'wrong__OPS1' });
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
  });

  it('keeps identical callsigns and display names isolated across centers', async () => {
    const a = profile(); const b = profile('b', 42);
    await start([a, b]);
    const aMetadata = await transmission(a, 'account-a');
    const bMetadata = await transmission(b, 'account-b');
    expect(aMetadata.principal.unitId).toBe(bMetadata.principal.unitId);
    expect(manager.resolvePttDispatcher('OPS1', aMetadata)).toBeNull();
    expect(manager.resolvePttDispatcher('OPS1', bMetadata)).toBeNull();
    expect(manager.resolvePttDispatcher(a.room_key, aMetadata).transmission.binding.dispatchCenterId).toBe('center-a');
    expect(manager.resolvePttDispatcher(b.room_key, bMetadata).transmission.binding.dispatchCenterId).toBe('center-b');
    expect(manager.resolvePttDispatcher(b.room_key, aMetadata)).toBeNull();
    expect(manager.resolvePttDispatcher(a.room_key, bMetadata)).toBeNull();
  });

  it('rejects stale runtime/context mismatches even with a matching grant', async () => {
    await start();
    const metadata = await transmission();
    const runtime = manager.runtimes.get('profile-a');
    runtime.context = { ...runtime.context, dispatchCenterId: 'another-center' };
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
  });

  it('does not overwrite the complete mapping with an older single-profile read during startup', async () => {
    const oldProfile = profile();
    fixture.profiles = [{ ...oldProfile, dispatch_center_id: 'center-reconfigured' }];
    manager = new AIDispatcherRuntimeManager();
    manager.ensureSchema = vi.fn(async () => {});
    manager.getProfileRow = vi.fn(async () => oldProfile);
    await manager.startProfile(oldProfile.id);
    const metadata = await transmission();
    expect(manager.runtimes.get(oldProfile.id).context.dispatchCenterId).toBe('center-a');
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
  });

  it('refreshes the complete mapping when configuration is read again', async () => {
    await start();
    const metadata = await transmission();
    expect(manager.resolvePttDispatcher('41', metadata)).not.toBeNull();
    fixture.profiles.push(profile('b', 41, { enabled: false, room_key: 'a__OPS1' }));
    await manager.listProfilesWithStatus();
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
  });

  it('fails closed on a configuration read failure until a complete refresh succeeds', async () => {
    await start();
    const metadata = await transmission();
    expect(manager.resolvePttDispatcher('41', metadata)).not.toBeNull();
    query.mockRejectedValueOnce(new Error('synthetic configuration outage'));
    await expect(manager.listProfilesWithStatus()).rejects.toThrow('synthetic configuration outage');
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
    await manager.listProfilesWithStatus();
    expect(manager.resolvePttDispatcher('41', metadata)).not.toBeNull();
  });

  it('includes newly created disabled profile mappings immediately and removes deleted mappings', async () => {
    await start();
    const metadata = await transmission();
    manager._normalizeInput = vi.fn(async () => ({
      name: 'Center b', enabled: false, channelId: 41, channelName: 'OPS1', roomKey: 'a__OPS1',
      dispatchCenterId: 'center-b', statusChecksEnabled: false,
    }));
    const created = await manager.createProfile({});
    expect(manager.runtimes.size).toBe(1);
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
    await manager.deleteProfile(created.id);
    expect(manager.resolvePttDispatcher('41', metadata)).not.toBeNull();
  });

  it('updates disabled profile mappings without waiting for another runtime to start', async () => {
    await start([profile(), profile('b', 42, { enabled: false })]);
    const metadata = await transmission();
    expect(manager.resolvePttDispatcher('41', metadata)).not.toBeNull();
    manager._normalizeInput = vi.fn(async () => ({
      name: 'Center b', enabled: false, channelId: 41, channelName: 'OPS1', roomKey: 'a__OPS1',
      dispatchCenterId: 'center-b', statusChecksEnabled: false,
    }));
    await manager.updateProfile('profile-b', {});
    expect(manager.runtimes.size).toBe(1);
    expect(manager.resolvePttDispatcher('41', metadata)).toBeNull();
  });
});

describe('01-02 manager callbacks and compatibility forwarding', () => {
  it('preserves transmission ownership and capture times on normal, drained and forced ends', async () => {
    await start();
    const metadata = await transmission();
    const dispatcher = manager.runtimes.get('profile-a').dispatcher;
    const ended = finishPttTransmission(metadata, 1500);
    await emit('start', { channelId: 'a__OPS1', unitId: 'A1', isEmergency: true }, metadata);
    const boundStart = dispatcher.handlePttStart.mock.calls[0][3];
    expect(dispatcher.handlePttStart).toHaveBeenCalledWith('a__OPS1', 'A1', true, boundStart);
    for (const data of [
      { channelId: 'a__OPS1', unitId: 'A1', gracePeriodMs: 0 },
      { channelId: 'a__OPS1', unitId: 'A1', gracePeriodMs: 400, drained: true },
      { channelId: 'a__OPS1', unitId: 'A1', gracePeriodMs: 0, forced: true },
    ]) await emit('end', data, ended);
    const boundEnd = dispatcher.handlePttEnd.mock.calls[0][3];
    expect(boundEnd.captureStartedAt).toBe(1000);
    expect(boundEnd.captureEndedAt).toBe(1500);
    expect(samePttTransmission(boundStart, boundEnd)).toBe(true);
    expect(dispatcher.handlePttEnd.mock.calls.map((args) => args[3])).toEqual([boundEnd, boundEnd, boundEnd]);
    expect(dispatcher.handlePttEnd.mock.calls[1][2]).toBe(400);
  });

  it('reads private event metadata when the internal callback has only its legacy data argument', async () => {
    await start();
    const metadata = await transmission();
    const data = attachPttMetadata({ channelId: 'a__OPS1', unitId: 'A1' }, metadata);
    await emit('start', data);
    const dispatcher = manager.runtimes.get('profile-a').dispatcher;
    expect(dispatcher.handlePttStart).toHaveBeenCalledTimes(1);
    expect(samePttTransmission(dispatcher.handlePttStart.mock.calls[0][3], metadata)).toBe(true);
    expect(JSON.parse(JSON.stringify(data))).toEqual({ channelId: 'a__OPS1', unitId: 'A1' });
  });

  it('never fans a proved transmission into another center with a matching display name', async () => {
    const a = profile(); const b = profile('b', 42);
    await start([a, b]);
    const metadata = await transmission(b);
    await emit('start', { channelId: b.room_key, unitId: 'A1' }, metadata);
    expect(manager.runtimes.get(a.id).dispatcher.handlePttStart).not.toHaveBeenCalled();
    expect(manager.runtimes.get(b.id).dispatcher.handlePttStart).toHaveBeenCalledTimes(1);
  });

  it('carries both positional compatibility layers to the matching non-primary runtime', async () => {
    const a = profile(); const b = profile('b', 42);
    await start([a, b]);
    const metadata = await transmission(b);
    const ended = finishPttTransmission(metadata, 1200);
    expect(getDispatcher().profileId).toBe(a.id);
    expect(await aiDispatcherSignaling.handlePttStart(b.room_key, 'A1', true, metadata)).toBe(true);
    expect(await aiDispatcherSignaling.handlePttEnd(b.room_key, 'A1', 250, ended)).toBe(true);
    const dispatcher = manager.runtimes.get(b.id).dispatcher;
    const bound = manager.resolvePttDispatcher(b.room_key, metadata).transmission;
    const boundEnd = manager.resolvePttDispatcher(b.room_key, ended).transmission;
    expect(dispatcher.handlePttStart).toHaveBeenCalledWith(b.room_key, 'A1', true, bound);
    expect(dispatcher.handlePttEnd).toHaveBeenCalledWith(b.room_key, 'A1', 250, boundEnd);
    expect(manager.runtimes.get(a.id).dispatcher.handlePttStart).not.toHaveBeenCalled();
    expect(manager.runtimes.get(a.id).dispatcher.handlePttEnd).not.toHaveBeenCalled();
  });

  it('rejects missing metadata through managed events and both compatibility layers', async () => {
    await start();
    await emit('start', { channelId: 'a__OPS1', unitId: 'A1' });
    await emit('end', { channelId: 'a__OPS1', unitId: 'A1' });
    expect(await aiDispatcherSignaling.handlePttStart('a__OPS1', 'A1')).toBe(false);
    expect(await getDispatcher().handlePttEnd('a__OPS1', 'A1')).toBe(false);
    const dispatcher = manager.runtimes.get('profile-a').dispatcher;
    expect(dispatcher.handlePttStart).not.toHaveBeenCalled();
    expect(dispatcher.handlePttEnd).not.toHaveBeenCalled();
  });

  it('keeps the existing hardware-emergency channel callbacks independent of speech metadata', async () => {
    await start();
    await emit('emergencyStart', { channelId: 'a__OPS1', unitId: 'A1' });
    await emit('emergencyEnd', { channelId: 'a__OPS1', unitId: 'A1' });
    const dispatcher = manager.runtimes.get('profile-a').dispatcher;
    expect(dispatcher.handleEmergencyStart).toHaveBeenCalledWith('a__OPS1', 'A1');
    expect(dispatcher.handleEmergencyEnd).toHaveBeenCalledWith('a__OPS1', 'A1');
  });
});
