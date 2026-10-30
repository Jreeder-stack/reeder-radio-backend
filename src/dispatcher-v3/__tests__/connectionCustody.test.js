// CI scope / 02-07: real V3 PTT acceptance against synthetic credential and CAD boundaries.
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw Error('External STT forbidden'); },
  textToSpeech: () => { throw Error('External TTS forbidden'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw Error('External paging forbidden'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw Error('External model forbidden'); } } }));
import { V3ConnectionCustody } from '../connectionCustody.js';
import { createHarness, finish, until, START_TIME, plan } from './helpers/auditRuntimeHarness.js';

let all, guard;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-no-network');
  guard = vi.fn(() => { throw Error('External network forbidden'); });
  vi.stubGlobal('fetch', guard); all = [];
});
afterEach(async () => {
  try {
    for (const h of all) await h.close();
    expect(guard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});
async function make(options = {}) {
  const h = await createHarness(options); all.push(h); return h;
}
async function speak(h, text, principal, unit = 'A1') {
  const capture = await h.capture(unit, { principal });
  expect(capture.accepted).toBe(true);
  h.frame(capture);
  const outcome = await finish(h.end(capture, text));
  await h.flushOutput();
  return outcome;
}
function socket(h, principal, id, channel = h.context.roomKey) {
  const s = {
    connected: true, pttPrincipal: principal, unitId: principal.unitId,
    channels: new Set([channel]), rooms: new Set([`channel:${channel}`]),
  };
  h.runtime.signaling.io.sockets ||= { sockets: new Map() };
  h.runtime.signaling.io.sockets.sockets.set(id, s);
  return s;
}
const id = (connectionId) => ({
  runtimeId: 'runtime', runtimeGeneration: 'generation', dispatchCenterId: 'center-a',
  speakerRef: 'A1', accountId: 'account-1', credentialType: 'session', connectionId,
});

describe('AI-DISP-V3-001 02-07 authenticated continuity and routing', () => {
  it('bounds replacement leases and never re-admits an old connection while the lease is live', () => {
    let time = 1;
    const owner = new V3ConnectionCustody({ now: () => time, maxReplacements: 2, leaseMs: 100 });
    expect(owner.admit(id('old'))).toMatchObject({ accepted: true });
    expect(owner.admit(id('new'))).toMatchObject({ accepted: true, previousConnectionId: 'old' });
    expect(owner.isCurrent(id('new'))).toBe(true);
    expect(owner.isCurrent(id('old'))).toBe(false);
    expect(owner.admit(id('old'))).toMatchObject({ accepted: false, reason: 'replaced_session' });
    expect(owner.admit(id('third'))).toMatchObject({ accepted: true });
    expect(owner.admit(id('fourth'))).toMatchObject({ accepted: false, reason: 'session_replacement_capacity' });
    time += 101;
    expect(owner.isCurrent(id('third'))).toBe(false);
  });

  it('a reconnect can explicitly resume a disposition, but cannot answer the old delivered prompt', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    h.cad.calls.get('OLD-CALL').assigned_units = [{ unit_id: 'A1' }];
    const first = await h.principal('A1', { connectionId: 'reconnect:old' });
    await speak(h, 'Central, clear me from my call', first);
    const oldPrompt = h.runtime.conversationGate.pending.get('A1');
    expect(oldPrompt?.kind).toBe('disposition');
    const original = [...h.runtime.conversations.conversations.values()].find((value) => value.accountId === first.accountId);
    const second = await h.principal('A1', { accountId: first.accountId, connectionId: 'reconnect:new' });
    expect(await speak(h, 'No further action', second)).toBe(false);
    expect(h.runtime.conversationGate.pending.get('A1')).toBeUndefined();
    expect(h.writes('/api/radio/dispose')).toEqual([]);
    const record = [...h.runtime.conversations.conversations.values()].find((value) => value.accountId === second.accountId);
    expect(record.id).toBe(original.id);
    expect(record.connectionId).toBe('reconnect:new');
    expect(record.suspendedTasks.some((task) => task.kind === 'disposition')).toBe(true);
    await speak(h, 'Central, resume disposition', second);
    const nextPrompt = h.runtime.conversationGate.pending.get('A1');
    expect(nextPrompt?.kind).toBe('disposition');
    expect(nextPrompt?.promptState).toBe('delivered');
    expect(nextPrompt.sessionKey).not.toBe(oldPrompt.sessionKey);
    expect(nextPrompt.promptTurnId).not.toBe(oldPrompt.promptTurnId);
    const stale = await h.capture('A1', { principal: first });
    expect(stale.accepted).toBe(false);
  });

  it('does not move tasks between different accounts sharing a callsign', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    h.cad.calls.get('OLD-CALL').assigned_units = [{ unit_id: 'A1' }];
    const a = await h.principal('A1', { connectionId: 'owner-a' });
    await speak(h, 'Central, clear me from my call', a);
    const b = await h.principal('A1', { connectionId: 'owner-b' });
    await speak(h, 'Central, resume disposition', b);
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
    expect(h.runtime.conversations.conversations.size).toBe(2);
  });

  it('does not recover a different credential type or a replaced unit identity', async () => {
    const h = await make();
    h.cad.current.set('A1', 'OLD-CALL');
    h.cad.calls.get('OLD-CALL').assigned_units = [{ unit_id: 'A1' }];
    const a = await h.principal('A1', { connectionId: 'old-session' });
    await speak(h, 'Central, clear me from my call', a);
    const radio = await h.principal('A1', { accountId: a.accountId, credentialType: 'radio-token', connectionId: 'radio-device' });
    await speak(h, 'Central, resume disposition', radio);
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
    h.changeAccountUnit(a, 'B2');
    const result = await h.capture('A1', { principal: a });
    expect(result.accepted).toBe(true);
    h.frame(result);
    expect(await finish(h.end(result, 'Central, available'))).toBe(false);
    expect(h.writes('/api/radio/dispose')).toEqual([]);
  });

  it('old in-flight model work cannot perform a CAD write after authenticated replacement', async () => {
    const h = await make();
    const held = h.hold({ choices: [{ message: { content: JSON.stringify(plan('SET_UNIT_STATUS', { unitRef: 'A1', status: 'available' })) } }] });
    h.llm.mockImplementationOnce(() => held.promise);
    const first = await h.principal('A1', { connectionId: 'reconnect:one' });
    const capture = await h.capture('A1', { principal: first });
    h.frame(capture);
    const prior = h.end(capture, 'Central, change my status to available');
    await until(() => h.llm.mock.calls.length === 1, 'old model request');
    const second = await h.principal('A1', { accountId: first.accountId, connectionId: 'reconnect:two' });
    const later = await h.capture('A1', { principal: second });
    expect(later.accepted).toBe(true);
    held.resolve({ choices: [{ message: { content: JSON.stringify(plan('SET_UNIT_STATUS', { unitRef: 'A1', status: 'available' })) } }] });
    await finish(prior);
    expect(h.writes('/api/radio/status')).toEqual([]);
    h.frame(later);
    await finish(h.end(later, 'Central, radio check'));
    await h.flushOutput();
  });

  it('a real socket must remain connected, owner-matched and joined to its original channel', async () => {
    const h = await make();
    const principal = await h.principal('A1', { connectionId: 'socket:device1' });
    const s = socket(h, principal, 'device1');
    expect(await speak(h, 'Central, available', principal)).toBe(true);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    s.rooms.delete(`channel:${h.context.roomKey}`);
    expect((await h.capture('A1', { principal })).accepted).toBe(false);
    s.rooms.add(`channel:${h.context.roomKey}`);
    s.connected = false;
    expect((await h.capture('A1', { principal })).accepted).toBe(false);
  });

  it('disconnection or channel change during delayed model processing blocks writes and replies', async () => {
    const h = await make();
    const principal = await h.principal('A1', { connectionId: 'socket:device2' });
    const s = socket(h, principal, 'device2');
    const held = h.hold({ choices: [{ message: { content: JSON.stringify(plan('SET_UNIT_STATUS', { unitRef: 'A1', status: 'available' })) } }] });
    h.llm.mockImplementationOnce(() => held.promise);
    const c = await h.capture('A1', { principal });
    h.frame(c);
    const turn = h.end(c, 'Central, change my status to available');
    await until(() => h.llm.mock.calls.length === 1, 'model pending');
    s.channels.clear(); s.rooms.clear();
    held.resolve({ choices: [{ message: { content: JSON.stringify(plan('SET_UNIT_STATUS', { unitRef: 'A1', status: 'available' })) } }] });
    await finish(turn);
    await h.flushOutput();
    expect(h.writes('/api/radio/status')).toEqual([]);
    expect(h.spoken()).toEqual([]);
  });

  it('a radio-token reassignment does not turn A1 pending tasks into B2 authority', async () => {
    const h = await make();
    const a = await h.principal('A1', { credentialType: 'radio-token', connectionId: 'radio:A1' });
    h.cad.current.set('A1','OLD-CALL'); h.cad.calls.get('OLD-CALL').assigned_units = [{ unit_id: 'A1' }];
    await speak(h, 'Central, clear me from my call', a);
    h.changeAccountUnit(a, 'B2');
    const b = await h.principal('B2', { connectionId: 'radio:B2' });
    await speak(h, 'Central, resume disposition', b, 'B2');
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
    expect(h.writes('/api/radio/dispose')).toEqual([]);
  });

  it('runtime restart removes old session/custody without resurrecting tasks', async () => {
    const h = await make();
    const a = await h.principal('A1', { connectionId: 'reconnect:before' });
    h.cad.current.set('A1', 'OLD-CALL');
    h.cad.calls.get('OLD-CALL').assigned_units = [{ unit_id: 'A1' }];
    await speak(h, 'Central, clear me from my call', a);
    await h.runtime.stop(); await h.runtime.start();
    const b = await h.principal('A1', { accountId: a.accountId, connectionId: 'reconnect:after' });
    await speak(h, 'Central, resume disposition', b);
    expect(h.spoken().at(-1)).toMatch(/no unfinished earlier task/i);
  });
});
