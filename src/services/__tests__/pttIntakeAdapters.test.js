import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  query: vi.fn(), radio: vi.fn(), users: new Map(), sessions: new Map(), grants: new Map(),
  io: { handlers: new Map(), sockets: { sockets: new Map() }, on: vi.fn(), to: vi.fn(), close: vi.fn(), emit: vi.fn() },
  dispatch: { handlePttStart: vi.fn(), handlePttEnd: vi.fn() },
}));
vi.mock('../../db/index.js', () => ({
  default: { query: boundary.query }, getRadioByToken: boundary.radio,
  clearUnitEmergencyByIdentity: vi.fn(async () => null), updateRadioLastSeen: vi.fn(async () => null),
  upsertUnitPresence: vi.fn(async () => null), upsertDevice: vi.fn(async (id) => ({ id })),
  updateDeviceLastSeen: vi.fn(async () => null), getOrSetRadioDeviceUUID: vi.fn(async () => 'radio-device'),
  isAiDispatchEnabled: vi.fn(async () => true), getAiDispatchChannel: vi.fn(async () => 'Default__OPS1'),
  getAllChannels: vi.fn(async () => []),
}));
vi.mock('socket.io', () => ({ Server: class { constructor() { return boundary.io; } } }));
vi.mock('../audioRelayService.js', () => ({ audioRelayService: {
  clearTxWatchdog: vi.fn(), getLastPacketAt: vi.fn(() => null), refreshSubscriber: vi.fn(),
  removeSubscriber: vi.fn(), getChannelsForSubscriber: vi.fn(() => []),
} }));
vi.mock('../opusCodec.js', () => ({ opusCodec: { resetSenderDecoder: vi.fn(), releaseSenderDecoder: vi.fn() } }));
vi.mock('../locationService.js', () => ({ default: {} }));
vi.mock('../dispatchService.js', () => ({}));
vi.mock('../aiDispatchService.js', () => ({ getDispatcher: () => boundary.dispatch, startDispatcher: vi.fn() }));
vi.mock('../wsAudioBridge.js', () => ({ wsAudioBridge: { _authenticate: vi.fn() } }));
vi.mock('../audioRelaySiblingDeviceHardening.js', () => ({ installAudioRelaySiblingDeviceHardening: vi.fn() }));

import signature from 'cookie-signature';
import { config } from '../../config/env.js';
import { signalingService as service } from '../signalingService.js';
import { floorControlService as floor } from '../floorControlService.js';
import { installFloorIdentityHardening } from '../signalingFloorIdentityHardening.js';
import { upsertDevice } from '../../db/index.js';
import pttRouter from '../../routes/pttRoutes.js';
import { notifyPtt } from '../../controllers/dispatchController.js';
import {
  loadSessionPttPrincipal, loadRadioPttPrincipal, isTrustedPttPrincipal,
  createPttTransmission, finishPttTransmission, isTrustedPttTransmission,
  getPttMetadata, attachPttMetadata, samePttTransmission, matchPttChannelGrant,
  bindPttTransmission, ownsPttTransmission,
  findPttRequest,
} from '../pttProvenance.js';

const ROOM = 'Default__OPS1';
const DEVICE = '9fa318b2-ab0d-42e8-9ef3-1a9bbc260594';
let counter = 0;

function addAccount(id = 1, unit = 'A1', grants = [{ channel_id: 7, channel_name: 'OPS1', room_key: ROOM }]) {
  boundary.users.set(String(id), { id, unit_id: unit, username: `login-${id}`, status: 'active', role: 'user' });
  boundary.grants.set(String(id), grants);
  boundary.sessions.set(`session-${id}`, { user: { id } });
}

function socket(id = 'socket-a', unitId = 'A1') {
  return {
    id, unitId, username: 'login-1', deviceId: DEVICE, floorKey: DEVICE,
    channels: new Set([ROOM]), handshake: { address: '127.0.0.1', headers: {}, query: {} },
    emit: vi.fn(), on: vi.fn(), join: vi.fn(), leave: vi.fn(), disconnect: vi.fn(),
    to: vi.fn(() => ({ emit: vi.fn() })),
  };
}

async function provenSocket(id = 'socket-a', accountId = 1) {
  const sock = socket(id, boundary.users.get(String(accountId)).unit_id);
  sock.pttPrincipal = await loadSessionPttPrincipal(`session-${accountId}`, { connectionId: `socket:${id}` });
  boundary.io.sockets.sockets.set(id, sock);
  return sock;
}

function response() {
  const res = { statusCode: 200, body: null };
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.json = vi.fn((body) => { res.body = body; return res; });
  return res;
}

async function http(path, extra = {}) {
  const handler = pttRouter.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;
  const req = {
    sessionID: 'session-1', session: { user: { id: 1 }, deviceId: DEVICE }, headers: {},
    body: { channelId: ROOM, unitId: 'A1' }, ...extra,
  };
  const res = response();
  await handler(req, res);
  return { req, res };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T15:00:00Z'));
  vi.clearAllMocks();
  boundary.users.clear(); boundary.sessions.clear(); boundary.grants.clear(); boundary.io.handlers.clear(); boundary.io.sockets.sockets.clear();
  boundary.io.on.mockImplementation((name, callback) => boundary.io.handlers.set(name, callback));
  boundary.io.to.mockImplementation(() => ({ emit: vi.fn() }));
  boundary.dispatch.handlePttStart.mockResolvedValue(true);
  boundary.dispatch.handlePttEnd.mockResolvedValue(true);
  boundary.radio.mockResolvedValue(null);
  boundary.query.mockImplementation(async (sql, args = []) => {
    if (sql.includes('FROM session')) {
      const sess = boundary.sessions.get(args[0]);
      return { rows: sess ? [{ sess }] : [] };
    }
    if (sql.includes('FROM user_channel_access')) return { rows: boundary.grants.get(String(args[0])) || [] };
    if (sql.includes('FROM users WHERE id')) {
      const user = boundary.users.get(String(args[0]));
      return { rows: user?.status === 'active' ? [user] : [] };
    }
    if (sql.includes('FROM users u')) return { rows: boundary.grants.get(String(args[0])) || [] };
    if (sql.includes('FROM users')) {
      const user = [...boundary.users.values()].find((row) => args.includes(row.username) || args.includes(row.unit_id));
      return { rows: user ? [user] : [] };
    }
    throw new Error(`Unexpected synthetic query: ${sql}`);
  });
  service.activeTransmissions.clear(); service.drainingTransmissions.clear(); service.unitPresence.clear();
  service.emergencyStates.clear(); service.clearAirStates.clear(); service.channelMembers.clear();
  for (const callbacks of Object.values(service._eventCallbacks)) callbacks.splice(0);
  service.io = boundary.io;
  addAccount();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const callbacks of Object.values(service._eventCallbacks)) callbacks.splice(0);
  service.stop();
  for (const channel of [...floor.floorHolders.keys()]) floor.forceRelease(channel);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
});

describe('01-02 credential proof and private transmission metadata', () => {
  it('loads the active account and grants by the stored-session account ID', async () => {
    const principal = await loadSessionPttPrincipal('session-1');
    expect(isTrustedPttPrincipal(principal)).toBe(true);
    expect(principal).toMatchObject({ accountId: '1', unitId: 'A1', credentialType: 'session' });
    expect(principal.connectionId).not.toContain('session-1');
    expect(boundary.query.mock.calls.filter(([sql]) => sql.includes('FROM user_channel_access'))[0][1]).toEqual([1]);
    expect(boundary.query.mock.calls[0][0]).toContain('expire > NOW()');
    expect(JSON.stringify(principal)).not.toContain('session-1');
  });

  it.each(['missing', 'expired', 'no-account'])('rejects a %s session source', async (type) => {
    if (type === 'no-account') boundary.sessions.set(type, { user: { username: 'login-1' } });
    expect(await loadSessionPttPrincipal(type)).toBeNull();
  });

  it('rejects a disabled account even when the session remains present', async () => {
    boundary.users.get('1').status = 'disabled';
    expect(await loadSessionPttPrincipal('session-1')).toBeNull();
  });

  it('requires an unlocked token assigned to a resolvable active account', async () => {
    boundary.radio.mockResolvedValue({ radio_id: 'R1', assigned_unit_id: 1, is_locked: false });
    const principal = await loadRadioPttPrincipal('synthetic-token');
    expect(principal).toMatchObject({ accountId: '1', unitId: 'A1', credentialType: 'radio-token' });
    expect(boundary.radio).toHaveBeenCalledWith('synthetic-token');
    expect(JSON.stringify(principal)).not.toContain('synthetic-token');
  });

  it.each([
    null,
    { radio_id: 'R1', assigned_unit_id: 1, is_locked: true },
    { radio_id: 'R1', assigned_unit_id: null },
    { radio_id: 'R1', assigned_unit_id: 999 },
  ])('does not invent account proof from unusable radio assignment %j', async (radio) => {
    boundary.radio.mockResolvedValue(radio);
    expect(await loadRadioPttPrincipal('synthetic-token')).toBeNull();
  });

  it('rejects client JSON flags, serialized principals and serialized transmissions', async () => {
    const principal = await loadSessionPttPrincipal('session-1');
    expect(createPttTransmission({ ...principal, authenticated: true }, { channelId: 7 })).toBeNull();
    const transmission = createPttTransmission(principal, { channelId: 7 });
    expect(isTrustedPttTransmission({ ...transmission })).toBe(false);
    expect(finishPttTransmission({ ...transmission })).toBeNull();
  });

  it('freezes all principal grants and identity fields and never serializes event proof', async () => {
    const principal = await loadSessionPttPrincipal('session-1');
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal.channelGrants)).toBe(true);
    expect(Object.isFrozen(principal.channelGrants[0])).toBe(true);
    const metadata = createPttTransmission(principal, { channelId: ROOM });
    const event = attachPttMetadata({ channelId: ROOM, unitId: 'A1' }, metadata);
    expect(getPttMetadata(event)).toBe(metadata);
    expect(JSON.parse(JSON.stringify(event))).toEqual({ channelId: ROOM, unitId: 'A1' });
  });

  it('rejects unauthorized channels and ambiguous display names', async () => {
    boundary.grants.get('1').push({ channel_id: 8, channel_name: 'OPS1', room_key: 'Other__OPS1' });
    const principal = await loadSessionPttPrincipal('session-1');
    expect(matchPttChannelGrant(principal, 'OPS1')).toBeNull();
    expect(matchPttChannelGrant(principal, 7).roomKey).toBe(ROOM);
    expect(createPttTransmission(principal, { channelId: 9 })).toBeNull();
  });

  it('keeps connection/account ownership separate even for repeated callsigns', async () => {
    addAccount(2, 'A1');
    const a = await loadSessionPttPrincipal('session-1');
    const b = await loadSessionPttPrincipal('session-2');
    const repeated = await loadSessionPttPrincipal('session-1');
    const transmission = createPttTransmission(a, { channelId: 7 });
    expect(ownsPttTransmission(transmission, b)).toBe(false);
    expect(ownsPttTransmission(transmission, repeated)).toBe(true);
    expect(a.connectionId).not.toBe(b.connectionId);
  });

  it('returns the same completed transmission for duplicate end and validates bound identity', async () => {
    const start = createPttTransmission(await loadSessionPttPrincipal('session-1'), { channelId: 7, captureStartedAt: 100 });
    const end = finishPttTransmission(start, 200);
    expect(finishPttTransmission(start, 300)).toBe(end);
    expect(samePttTransmission(start, end)).toBe(true);
    const binding = { channelId: '7', roomKey: ROOM, dispatchCenterId: 'center-a', profileId: 'profile-a' };
    const bound = bindPttTransmission(end, binding);
    expect(bindPttTransmission(bound, binding)).toBe(bound);
    expect(Object.isFrozen(bound.binding)).toBe(true);
    expect(samePttTransmission(start, bound)).toBe(true);
    expect(bindPttTransmission(end, { ...binding, channelId: '8' })).toBeNull();
  });

  it('retains optional request IDs only for their proven account, connection and channel', async () => {
    const owner = await loadSessionPttPrincipal('session-1', { connectionId: `request-owner-${++counter}` });
    const other = await loadSessionPttPrincipal('session-1', { connectionId: `request-other-${counter}` });
    const requestId = `accepted-${counter}`;
    const start = createPttTransmission(owner, { channelId: 7, clientRequestId: requestId });
    finishPttTransmission(start);
    expect(findPttRequest(owner, ROOM, requestId)).toBe(start);
    expect(findPttRequest(other, ROOM, requestId)).toBeNull();
    expect(findPttRequest(owner, '9', requestId)).toBeNull();
    expect(JSON.stringify(start)).not.toContain(requestId);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(findPttRequest(owner, ROOM, requestId)).toBeNull();
  });

  it('bounds optional request ID retention when a source produces many transmissions', async () => {
    const owner = await loadSessionPttPrincipal('session-1', { connectionId: `bounded-owner-${++counter}` });
    for (let index = 0; index <= 2048; index += 1) {
      createPttTransmission(owner, { channelId: 7, clientRequestId: `bounded-${index}` });
    }
    expect(findPttRequest(owner, 7, 'bounded-0')).toBeNull();
    expect(findPttRequest(owner, 7, 'bounded-2048')).not.toBeNull();
  });
});

describe('01-02 actual signaling and HTTP entry paths', () => {
  it('a canonical callsign lookup without a signed session never authenticates an AI actor', async () => {
    const sock = socket();
    await service._handleAuthenticate(sock, { unitId: 'A1', username: 'login-1' });
    expect(sock.unitId).toBe('A1');
    expect(sock.pttPrincipal).toBeNull();
    service._handlePttStart(sock, { channelId: ROOM });
    expect(getPttMetadata(service.activeTransmissions.get(ROOM))).toBeNull();
  });

  it.each(['unsigned', 'invalid-signature'])('does not treat a %s cookie as session proof', async (kind) => {
    const sock = socket();
    sock.handshake.headers.cookie = `connect.sid=${kind === 'unsigned' ? 'session-1' : 's:session-1.bad'}`;
    await service._handleAuthenticate(sock, { unitId: 'A1', username: 'login-1' });
    expect(sock.pttPrincipal).toBeNull();
  });

  it('signed stored-session auth overrides a claimed speaker with the actual account', async () => {
    const sock = socket();
    sock.handshake.headers.cookie = `connect.sid=${encodeURIComponent(`s:${signature.sign('session-1', config.sessionSecret)}`)}`;
    await service._handleAuthenticate(sock, { unitId: 'B2', username: 'claimed-other' });
    expect(sock.pttPrincipal).toMatchObject({ unitId: 'A1', accountId: '1', connectionId: 'socket:socket-a' });
    expect(sock.unitId).toBe('A1');
  });

  it('actual radio-token connection issues proof from its enabled assigned account', async () => {
    service.initialize({});
    boundary.radio.mockResolvedValue({ radio_id: 'R1', assigned_unit_id: 1, is_locked: false });
    const sock = socket(); sock.handshake.query.radioToken = 'synthetic-token';
    await boundary.io.handlers.get('connection')(sock);
    expect(sock.pttPrincipal).toMatchObject({ accountId: '1', unitId: 'A1', credentialType: 'radio-token' });
    service._handlePttRequest(sock, { channelId: ROOM });
    expect(getPttMetadata(service.activeTransmissions.get(ROOM)).principal).toBe(sock.pttPrincipal);
  });

  it('unassigned token radio retains no authenticated CAD speaker', async () => {
    service.initialize({});
    boundary.radio.mockResolvedValue({ radio_id: 'R1', assigned_unit_id: null, is_locked: false });
    const sock = socket(); sock.handshake.query.radioToken = 'synthetic-token';
    await boundary.io.handlers.get('connection')(sock);
    expect(sock.pttPrincipal).toBeNull();
  });

  it('legacy start/end/drain forwards one immutable identity in private callback metadata', async () => {
    const sock = await provenSocket();
    const starts = [], ends = [];
    service.onPttStart((data, metadata) => starts.push([data, metadata]));
    service.onPttEnd((data, metadata) => ends.push([data, metadata]));
    service._handlePttStart(sock, { channelId: ROOM });
    const original = service.activeTransmissions.get(ROOM);
    service._handlePttStart(sock, { channelId: ROOM });
    expect(service.activeTransmissions.get(ROOM)).toBe(original);
    vi.advanceTimersByTime(10);
    service._handlePttEnd(sock, { channelId: ROOM });
    service._handlePttEnd(sock, { channelId: ROOM });
    vi.advanceTimersByTime(service.TX_DRAIN_MS);
    expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
    expect(samePttTransmission(starts[0][1], ends[0][1])).toBe(true);
    expect(ends[0][1].captureEndedAt - starts[0][1].captureStartedAt).toBe(10);
    expect(JSON.stringify(starts[0][0])).not.toContain('principal');
  });

  it('an old drain callback cannot end a newer capture or replace its identity', async () => {
    const sock = await provenSocket();
    const ends = [];
    service.onPttEnd((_, metadata) => ends.push(metadata));
    service._handlePttStart(sock, { channelId: ROOM });
    const old = getPttMetadata(service.activeTransmissions.get(ROOM));
    service._handlePttEnd(sock, { channelId: ROOM });
    const oldDrain = service.drainingTransmissions.get(ROOM);
    service._handlePttStart(sock, { channelId: ROOM });
    const newer = getPttMetadata(service.activeTransmissions.get(ROOM));
    service._checkDrain(ROOM, oldDrain);
    expect(ends).toHaveLength(1);
    expect(samePttTransmission(old, ends[0])).toBe(true);
    expect(newer.transmissionId).not.toBe(old.transmissionId);
    expect(getPttMetadata(service.activeTransmissions.get(ROOM))).toBe(newer);
    service._handlePttEnd(sock, { channelId: ROOM });
    const newDrain = service.drainingTransmissions.get(ROOM);
    service._finalizeDrain(ROOM, oldDrain);
    expect(service.drainingTransmissions.get(ROOM)).toBe(newDrain);
    service._finalizeDrain(ROOM, newDrain);
    expect(ends).toHaveLength(2);
  });

  it.each(['release', 'tx-stop', 'forced', 'leave', 'disconnect-cleanup', 'timeout'])('%s retains the accepted source metadata', async (terminal) => {
    if (terminal === 'timeout') service.initialize({});
    const sock = await provenSocket();
    const ends = [];
    service.onPttEnd((_, metadata) => ends.push(metadata));
    service._handlePttRequest(sock, { channelId: ROOM });
    const original = getPttMetadata(service.activeTransmissions.get(ROOM));
    vi.advanceTimersByTime(25);
    if (terminal === 'release') service._handlePttRelease(sock, { channelId: ROOM });
    if (terminal === 'tx-stop') service._handleTxStop(sock, { channelId: ROOM });
    if (terminal === 'forced') service.forceEndTransmission(ROOM, sock.unitId, 'watchdog');
    if (terminal === 'leave') service._handleRadioLeaveChannel(sock, { channelId: ROOM });
    if (terminal === 'disconnect-cleanup') service.removeSocketFromChannels(sock, 'disconnect');
    if (terminal === 'timeout') { floor.forceRelease(ROOM); floor._onTimeout(ROOM, sock.floorKey); }
    expect(ends).toHaveLength(1);
    expect(samePttTransmission(original, ends[0])).toBe(true);
    expect(ends[0].captureEndedAt - original.captureStartedAt).toBe(25);
    expect(service.activeTransmissions.has(ROOM)).toBe(false);
  });

  it('a sibling connection with the same callsign and claimed device cannot end the owner capture', async () => {
    const owner = await provenSocket('owner');
    const other = await provenSocket('other');
    service._handlePttStart(owner, { channelId: ROOM });
    const original = service.activeTransmissions.get(ROOM);
    service._handlePttEnd(other, { channelId: ROOM });
    service._handlePttRelease(other, { channelId: ROOM });
    service._handleTxStop(other, { channelId: ROOM });
    service.removeSocketFromChannels(other, 'disconnect');
    expect(service.activeTransmissions.get(ROOM)).toBe(original);
    expect(floor.holdsFloor(ROOM, owner.floorKey)).toBe(true);
  });

  it.each(['legacy', 'radio'])('a same-callsign foreign connection cannot cancel a %s drain', async (path) => {
    const owner = await provenSocket('owner');
    const other = await provenSocket('other');
    service._handlePttStart(owner, { channelId: ROOM });
    service._handlePttEnd(owner, { channelId: ROOM });
    const drain = service.drainingTransmissions.get(ROOM);
    if (path === 'legacy') service._handlePttStart(other, { channelId: ROOM });
    else service._handlePttRequest(other, { channelId: ROOM });
    expect(service.drainingTransmissions.get(ROOM)).toBe(drain);
    expect(service.activeTransmissions.size).toBe(0);
  });

  it('repeated clear-air start retains the original capture', async () => {
    const sock = await provenSocket(); sock.isDispatcher = true;
    service.clearAirStates.set(ROOM, { dispatcherId: 'A1' });
    service._handlePttStart(sock, { channelId: ROOM, isClearAir: true });
    const original = service.activeTransmissions.get(ROOM);
    service._handlePttStart(sock, { channelId: ROOM, isClearAir: true });
    expect(service.activeTransmissions.get(ROOM)).toBe(original);
  });

  it('installed legacy hardening preserves duplicate active radio starts and emits proof when clearing a stale floor', async () => {
    const isolated = new service.constructor(); isolated.io = boundary.io;
    const sock = await provenSocket();
    const starts = [], ends = [];
    isolated.onPttStart((_, metadata) => starts.push(metadata));
    isolated.onPttEnd((_, metadata) => ends.push(metadata));
    installFloorIdentityHardening(isolated);
    isolated._handlePttRequest(sock, { channelId: ROOM, requestId: 'start-1' });
    const original = isolated.activeTransmissions.get(ROOM);
    isolated._handlePttRequest(sock, { channelId: ROOM, requestId: 'start-1' });
    expect(isolated.activeTransmissions.get(ROOM)).toBe(original);
    expect(starts).toHaveLength(1);
    floor.forceRelease(ROOM);
    isolated._handlePttRequest(sock, { channelId: ROOM, requestId: 'start-2' });
    expect(starts).toHaveLength(2); expect(ends).toHaveLength(1);
    expect(samePttTransmission(starts[0], ends[0])).toBe(true);
    isolated.stop();
  });

  it('installed consistency sweep emits the original tagged terminal identity once', async () => {
    const isolated = new service.constructor(); isolated.io = boundary.io;
    const sock = await provenSocket();
    const ends = [];
    isolated.onPttEnd((_, metadata) => ends.push(metadata));
    installFloorIdentityHardening(isolated);
    isolated._startActiveTransmissionsSweep();
    isolated._handlePttRequest(sock, { channelId: ROOM });
    const original = getPttMetadata(isolated.activeTransmissions.get(ROOM));
    floor.forceRelease(ROOM);
    vi.advanceTimersByTime(30000);
    expect(ends).toHaveLength(1);
    expect(samePttTransmission(original, ends[0])).toBe(true);
    expect(isolated.activeTransmissions.size).toBe(0);
    isolated.stop();
  });

  it.each(['legacy', 'radio'])('known request IDs suppress completed %s replays and reject mismatched ends', async (path) => {
    const sock = await provenSocket(`request-socket-${++counter}`);
    const starts = [];
    service.onPttStart((_, metadata) => starts.push(metadata));
    const data = { channelId: ROOM, requestId: `request-${counter}` };
    const start = () => path === 'legacy' ? service._handlePttStart(sock, data) : service._handlePttRequest(sock, data);
    const end = (requestId) => path === 'legacy'
      ? service._handlePttEnd(sock, { ...data, requestId })
      : service._handlePttRelease(sock, { ...data, requestId });
    start(); const original = service.activeTransmissions.get(ROOM);
    end('wrong-request');
    expect(service.activeTransmissions.get(ROOM)).toBe(original);
    end(data.requestId); vi.advanceTimersByTime(service.TX_DRAIN_MS);
    expect(service.activeTransmissions.has(ROOM)).toBe(false);
    start();
    expect(starts).toHaveLength(1);
    expect(service.activeTransmissions.has(ROOM)).toBe(false);
  });

  it('legacy no-ID transmissions remain distinct after completion because no replay evidence exists', async () => {
    const sock = await provenSocket(); const starts = [];
    service.onPttStart((_, metadata) => starts.push(metadata));
    service._handlePttRequest(sock, { channelId: ROOM });
    service._handlePttRelease(sock, { channelId: ROOM });
    service._handlePttRequest(sock, { channelId: ROOM });
    expect(starts).toHaveLength(2);
    expect(starts[0].transmissionId).not.toBe(starts[1].transmissionId);
  });

  it('HTTP presence alone cannot supply identity proof', async () => {
    service.unitPresence.set('A1', { unitId: 'A1', socketId: 'other' });
    const { res } = await http('/start', { session: null, sessionID: null });
    expect(res.statusCode).toBe(403);
    expect(service.activeTransmissions.size).toBe(0);
  });

  it('HTTP session account cannot borrow another account channel grant or callsign', async () => {
    addAccount(2, 'B2', [{ channel_id: 8, channel_name: 'OPS2', room_key: 'Other__OPS2' }]);
    const foreignChannel = await http('/start', { body: { channelId: 8, unitId: 'A1' } });
    expect(foreignChannel.res.statusCode).toBe(403);
    const foreignIdentity = await http('/start', { body: { channelId: 7, unitId: 'B2' } });
    expect(foreignIdentity.res.statusCode).toBe(403);
    expect(service.activeTransmissions.size).toBe(0);
  });

  it('HTTP duplicate start/end creates exactly one private transmission', async () => {
    const starts = [], ends = [];
    service.onPttStart((_, metadata) => starts.push(metadata));
    service.onPttEnd((_, metadata) => ends.push(metadata));
    expect((await http('/start')).res.statusCode).toBe(200);
    expect((await http('/start')).res.body.duplicate).toBe(true);
    expect((await http('/end')).res.statusCode).toBe(200);
    expect((await http('/end')).res.body.ignored).toBe(true);
    vi.advanceTimersByTime(service.TX_DRAIN_MS);
    expect(starts).toHaveLength(1); expect(ends).toHaveLength(1);
    expect(starts[0].source).toBe('http-ptt');
    expect(samePttTransmission(starts[0], ends[0])).toBe(true);
  });

  it('HTTP another session cannot end the owner even with same callsign/device', async () => {
    await http('/start');
    boundary.sessions.set('another-session', { user: { id: 1 } });
    const { res } = await http('/end', { sessionID: 'another-session' });
    expect(res.statusCode).toBe(403);
    expect(service.activeTransmissions.size).toBe(1);
    expect(upsertDevice).toHaveBeenCalledTimes(1);
  });

  it('HTTP optional request IDs reject wrong ends and suppress known-ID replay after completion', async () => {
    const body = { channelId: ROOM, unitId: 'A1', requestId: `http-${++counter}` };
    await http('/start', { body });
    const original = service.activeTransmissions.get(ROOM);
    expect((await http('/end', { body: { ...body, requestId: 'wrong-request' } })).res.statusCode).toBe(403);
    expect(service.activeTransmissions.get(ROOM)).toBe(original);
    await http('/end', { body }); vi.advanceTimersByTime(service.TX_DRAIN_MS);
    expect((await http('/start', { body })).res.body.duplicate).toBe(true);
    expect(service.activeTransmissions.has(ROOM)).toBe(false);
  });

  it('notify-PTT proves canonical account and preserves metadata through its compatibility entry', async () => {
    const sessionId = `notify-${++counter}`;
    boundary.sessions.set(sessionId, { user: { id: 1 } });
    const req = { sessionID: sessionId, session: { user: { id: 1 } }, body: { channel: ROOM, identity: 'login-1', action: 'start' } };
    const startRes = response(); await notifyPtt(req, startRes);
    expect(startRes.body.triggered).toBe(true);
    const start = boundary.dispatch.handlePttStart.mock.calls[0];
    expect(start.slice(0, 3)).toEqual([ROOM, 'A1', false]);
    expect(isTrustedPttTransmission(start[3])).toBe(true);
    await notifyPtt(req, response());
    expect(boundary.dispatch.handlePttStart).toHaveBeenCalledTimes(1);
    req.body.action = 'end'; await notifyPtt(req, response()); await notifyPtt(req, response());
    expect(boundary.dispatch.handlePttEnd).toHaveBeenCalledTimes(1);
    expect(samePttTransmission(start[3], boundary.dispatch.handlePttEnd.mock.calls[0][3])).toBe(true);
  });

  it('notify-PTT refuses a supplied identity without real session proof', async () => {
    const res = response();
    await notifyPtt({ body: { channel: ROOM, identity: 'A1', action: 'start' } }, res);
    expect(res.statusCode).toBe(403);
    expect(boundary.dispatch.handlePttStart).not.toHaveBeenCalled();
  });

  it('notify-PTT suppresses concurrent duplicate starts and known-ID replay after completion', async () => {
    const sessionId = `notify-${++counter}`;
    boundary.sessions.set(sessionId, { user: { id: 1 } });
    const req = { sessionID: sessionId, session: { user: { id: 1 } }, body: { channel: ROOM, action: 'start', requestId: `notify-request-${counter}` } };
    await Promise.all([notifyPtt(req, response()), notifyPtt(req, response())]);
    expect(boundary.dispatch.handlePttStart).toHaveBeenCalledTimes(1);
    await notifyPtt({ ...req, body: { ...req.body, action: 'end', requestId: 'wrong-request' } }, response());
    expect(boundary.dispatch.handlePttEnd).not.toHaveBeenCalled();
    await notifyPtt({ ...req, body: { ...req.body, action: 'end' } }, response());
    await notifyPtt(req, response());
    expect(boundary.dispatch.handlePttStart).toHaveBeenCalledTimes(1);
  });
});
