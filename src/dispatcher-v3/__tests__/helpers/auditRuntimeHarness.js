import { expect, vi } from 'vitest';

// Only the database boundary is synthetic. The production credential issuer,
// account-grant checks and private provenance tags remain real in these tests.
const credentialDatabase = {
  nextId: 1, sessions: new Map(), accounts: new Map(), grants: new Map(), radios: new Map(),
};
async function queryCredentialDatabase(sql, parameters = []) {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  const key = String(parameters[0]);
  if (/FROM session WHERE sid = \$1 AND expire > NOW\(\)/i.test(query)) {
    const session = credentialDatabase.sessions.get(key);
    return { rows: session ? [{ sess: structuredClone(session) }] : [] };
  }
  if (/FROM users WHERE id = \$1 AND status = 'active'/i.test(query)) {
    const account = credentialDatabase.accounts.get(key);
    return { rows: account?.status === 'active' ? [structuredClone(account)] : [] };
  }
  if (/FROM user_channel_access uca JOIN channels ch/i.test(query)) {
    return { rows: structuredClone(credentialDatabase.grants.get(key) || []) };
  }
  if (/FROM radios WHERE token = \$1/i.test(query)) {
    const radio = credentialDatabase.radios.get(key);
    return { rows: radio ? [structuredClone(radio)] : [] };
  }
  throw new Error(`Unexpected synthetic credential query: ${query}`);
}

import pool from '../../../db/index.js';
import { V3LiveDispatcher } from '../../liveRuntime.js';
import { V3IntentPlanner } from '../../intentPlanner.js';
import { V3DiagnosticsJournal } from '../../diagnostics.js';
import {
  bindPttTransmission, createPttTransmission, finishPttTransmission,
  loadRadioPttPrincipal, loadSessionPttPrincipal,
} from '../../../services/pttProvenance.js';

export const BASE_SHA = 'c5ce5feed7a4feadb86ddca3d6d8c89e2c2f90fa';
export const START_TIME = new Date('2026-10-28T17:00:00.000Z');
export const NO_ACTION = { action: 'NO_ACTION', input: {}, confidence: 1 };
export const plan = (action, input = {}) => ({ action, input, confidence: 1 });

export function deferred(fallback) {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject, fallback };
}

// Move fake time only. A fixture mistake must fail, never hang the runner.
export async function until(predicate, label, limitMs = 1000) {
  for (let elapsed = 0; elapsed <= limitMs; elapsed += 1) {
    if (predicate()) return;
    await vi.advanceTimersByTimeAsync(1);
  }
  throw new Error(`Audit fixture did not reach ${label} within ${limitMs} virtual milliseconds`);
}

export function observe(promise) {
  const state = { settled: false, value: undefined, error: null };
  state.done = promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

export async function finish(turn) {
  await until(() => turn.settled, 'turn completion');
  if (turn.error) throw turn.error;
  return turn.value;
}

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
}

/** In-memory HTTP boundary. No dispatcher module, handler or verifier is replaced. */
function createCad(context) {
  const units = ['A1', 'B2', 'C3', 'D4', 'E5'].map((callsign) => ({
    id: `${context.dispatchCenterId}-${callsign}`, unit_number: callsign,
    unit_id: callsign, status: 'on_duty', agency_id: 'synthetic-agency',
  }));
  const makeCall = (id, type, location) => ({
    id, call_id: id, call_number: id, type, nature: type, location,
    status: 'active', assigned_units: [], call_notes: [],
  });
  const calls = new Map([
    ['OLD-CALL', makeCall('OLD-CALL', 'ALARM', 'Walmart')],
    ['NEW-CALL', makeCall('NEW-CALL', 'TRAFFIC STOP', '200 Oak Street')],
  ]);
  const current = new Map(units.map((unit) => [unit.unit_number, null]));
  const requests = [];
  const faults = [];
  const cad = { units, calls, current, requests, faults, failNotes: false, failStatus: false, ignoreStatusWrite: false,
    missingUnits: new Set(), ambiguousUnits: new Set(), resolveWaits: new Map() };
  cad.fetch = vi.fn(async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    const headers = new Headers(options.headers);
    if (url.origin !== context.cadUrl || url.searchParams.get('dispatch_center_id') !== context.dispatchCenterId
        || headers.get('x-dispatch-center-id') !== context.dispatchCenterId
        || headers.get('x-dispatcher-runtime-id') !== context.runtimeId
        || !headers.get('x-correlation-id')) {
      faults.push(`Unexpected outbound identity or destination: ${method} ${url}`);
      throw new Error(faults.at(-1));
    }
    requests.push({ method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, at: Date.now(), center: context.dispatchCenterId });
    const path = url.pathname;
    const copy = (value) => structuredClone(value);
    if (method === 'GET' && path === '/api/radio/unit/resolve-v3') {
      const ref = url.searchParams.get('unit_ref');
      if (cad.resolveWaits.has(ref)) await cad.resolveWaits.get(ref);
      if (cad.ambiguousUnits.has(ref)) return json({ success: false, error: 'UNIT_AMBIGUOUS', candidates: [{ id: 'duplicate-1' }, { id: 'duplicate-2' }] }, 409);
      if (cad.missingUnits.has(ref)) return json({ success: false, error: 'UNIT_NOT_FOUND' }, 404);
      const unit = units.find((item) => item.id === ref || item.unit_number.toLowerCase() === ref?.toLowerCase());
      return unit ? json({ success: true, unit: copy(unit) }) : json({ success: false, error: 'UNIT_NOT_FOUND' }, 404);
    }
    if (method === 'GET' && path === '/api/radio/status-check') return json({ success: true, units: copy(units) });
    if (method === 'GET' && /^\/api\/radio\/unit\/[^/]+\/call$/.test(path)) {
      const unit = decodeURIComponent(path.split('/')[4]);
      return json({ success: true, call: copy(calls.get(current.get(unit)) || null) });
    }
    if (method === 'GET' && (path === '/api/radio/calls' || path === '/api/radio/v3/cad/calls')) {
      return json({ success: true, calls: copy([...calls.values()]) });
    }
    if (method === 'GET' && (path.startsWith('/api/radio/v3/cad/calls/') || path.startsWith('/api/radio/call/'))) {
      const call = calls.get(decodeURIComponent(path.split('/').at(-1)));
      return call ? json({ success: true, call: copy(call) }) : json({ success: false, error: 'CALL_NOT_FOUND' }, 404);
    }
    if (method === 'GET' && path === '/api/radio/locations/resolve') {
      return json({ success: true, source: 'synthetic-fixture', location: { address: url.searchParams.get('q'), city: 'Test Borough', state: 'PA' } });
    }
    if (method === 'POST' && path === '/api/radio/status') {
      if (cad.failStatus) return json({ success: false, error: 'SYNTHETIC_WRITE_FAILURE' }, 503);
      const unit = units.find((item) => item.unit_number === body.unit_id);
      if (!unit) { faults.push(`Fixture status target missing: ${body.unit_id}`); throw new Error(faults.at(-1)); }
      if (!cad.ignoreStatusWrite) unit.status = body.status;
      return json({ success: true });
    }
    if (method === 'POST' && path === '/api/radio/note') {
      if (cad.failNotes) return json({ success: false, error: 'SYNTHETIC_NOTE_FAILURE' }, 503);
      const call = calls.get(body.call_id);
      if (!call) { faults.push(`Fixture note target missing: ${body.call_id}`); throw new Error(faults.at(-1)); }
      call.call_notes.push({ text: body.note });
      return json({ success: true });
    }
    if (method === 'POST' && path === '/api/radio/v3/cad/calls') {
      const id = `CREATED-${calls.size}`;
      const call = { ...makeCall(id, body.type, body.location), ...body,
        status: body.units.length ? 'assigned' : 'pending',
        assigned_units: body.units.map((unit_id) => ({ unit_id })),
      };
      calls.set(id, call);
      for (const unit of body.units) current.set(unit, id);
      return json({ success: true, call: copy(call) });
    }
    if (method === 'POST' && path === '/api/radio/assign') {
      calls.get(body.call_id).assigned_units.push({ unit_id: body.unit_id });
      current.set(body.unit_id, body.call_id);
      return json({ success: true });
    }
    if (method === 'POST' && (path === '/api/radio/dispose' || path === '/api/radio/clear')) {
      const call = calls.get(body.call_id);
      const leaving = body.unit_ids || [body.unit_id];
      call.assigned_units = call.assigned_units.filter((item) => !leaving.includes(item.unit_id));
      for (const unit of leaving) if (current.get(unit) === body.call_id) current.set(unit, null);
      if (path.endsWith('/dispose')) { call.status = 'closed'; call.disposition = body.disposition; }
      return json({ success: true });
    }
    faults.push(`Unimplemented synthetic CAD route: ${method} ${path}`);
    throw new Error(faults.at(-1));
  });
  return cad;
}

export async function createHarness({ center = 'center-a', scopes = ['unit.read', 'unit.write', 'call.read', 'call.write'], llmPlans = [] } = {}) {
  vi.spyOn(pool, 'query').mockImplementation(queryCredentialDatabase);
  const context = {
    runtimeId: `audit-${center}`, profileId: `profile-${center}`, dispatchCenterId: center,
    channelId: `channel-${center}`, roomKey: `${center}__OPS1`, channelName: 'OPS1',
    identity: `AI-DISPATCHER:${center}`, cadUrl: 'https://cad.example.test', cadApiKey: 'synthetic-no-real-key',
  };
  const cad = createCad(context);
  const sttReplies = [];
  const synthesisReplies = [];
  const listeners = new Map();
  const relay = {
    addAudioListener: vi.fn((channel, identity, listener) => listeners.set(String(channel), listener)),
    removeAllAudioListeners: vi.fn(() => listeners.clear()),
    hasRecentInbound: vi.fn(() => null), injectAudio: vi.fn(),
  };
  const floor = { requestFloor: vi.fn(() => ({ granted: true })), releaseFloor: vi.fn(() => true), releaseAllForUnit: vi.fn() };
  const codec = {
    decodeOpusToPcm: vi.fn(() => Buffer.alloc(640)), releaseSenderDecoder: vi.fn(),
    encodePcmToOpus: vi.fn(() => [Buffer.from([1])]),
  };
  const faults = cad.faults;
  const transcribe = vi.fn(async () => {
    if (!sttReplies.length) { faults.push('No synthetic STT reply configured'); throw new Error(faults.at(-1)); }
    return await sttReplies.shift();
  });
  const synthesize = vi.fn(async () => synthesisReplies.length ? await synthesisReplies.shift() : Buffer.alloc(640));
  const llm = vi.fn(async () => ({ choices: [{ message: { content: JSON.stringify(llmPlans.length ? llmPlans.shift() : NO_ACTION) } }] }));
  const diagnostics = new V3DiagnosticsJournal({ logger: null });
  const planner = new V3IntentPlanner({ client: { chat: { completions: { create: llm } } }, diagnostics });
  const runtime = new V3LiveDispatcher({
    runtimeContext: context, scopes, planner, diagnostics, transcribe, synthesize, codec, audioRelay: relay, floorControl: floor,
    signaling: { io: {}, emergencyStates: new Map(), unitPresence: new Map() },
    emergencyPager: vi.fn(() => { faults.push('Unexpected emergency page'); throw new Error(faults.at(-1)); }),
  });
  // Inject only the external HTTP boundary. All dispatcher internals remain real.
  runtime.gateway.fetchImpl = cad.fetch;
  vi.spyOn(runtime.planner, 'plan');
  vi.spyOn(runtime.executor, 'execute');
  vi.spyOn(runtime.speech, 'startTransmission');
  vi.spyOn(runtime.speech, 'endTransmission');
  vi.spyOn(runtime, '_speak');
  vi.spyOn(diagnostics, 'record');
  const turns = [];
  const deferreds = [];
  const principals = new Map();
  const credentials = [];
  const binding = { profileId: context.profileId, channelId: context.channelId, roomKey: context.roomKey, dispatchCenterId: context.dispatchCenterId };
  const h = {
    runtime, context, cad, relay, floor, codec, transcribe, synthesize, llm, llmPlans, sttReplies, synthesisReplies, turns, deferreds, diagnostics, binding,
    hold(fallback) { const value = deferred(fallback); deferreds.push(value); return value; },
    writes(path) { return cad.requests.filter((request) => request.method !== 'GET' && (!path || request.path === path)); },
    revokeAccount(principal) {
      const account = credentialDatabase.accounts.get(String(principal.accountId));
      if (account) account.status = 'inactive';
    },
    revokeChannelGrant(principal) {
      credentialDatabase.grants.set(String(principal.accountId), []);
    },
    changeAccountUnit(principal, unitId) {
      const account = credentialDatabase.accounts.get(String(principal.accountId));
      if (account) account.unit_id = unitId;
    },
    spoken() { return synthesize.mock.calls.map(([text]) => text); },
    async principal(unit = 'A1', options = {}) {
      const cacheKey = `${unit}:${options.connectionId || 'default'}:${options.credentialType || 'session'}`;
      if (!Object.keys(options).length && principals.has(cacheKey)) return principals.get(cacheKey);
      const id = String(options.accountId || credentialDatabase.nextId++);
      const credential = `synthetic-credential-${center}-${credentialDatabase.nextId++}`;
      const account = { id, username: `operator-${id}`, unit_id: unit, role: 'user', is_dispatcher: false, status: options.status || 'active' };
      credentialDatabase.accounts.set(id, account);
      credentialDatabase.grants.set(id, options.grants || [{ channel_id: context.channelId, channel_name: context.channelName, room_key: context.roomKey }]);
      credentials.push({ id, credential });
      let principal;
      if (options.credentialType === 'radio-token') {
        credentialDatabase.radios.set(credential, { radio_id: `radio-${id}`, assigned_unit_id: id, is_locked: false });
        principal = await loadRadioPttPrincipal(credential, { connectionId: options.connectionId });
      } else {
        credentialDatabase.sessions.set(credential, { user: { id } });
        principal = await loadSessionPttPrincipal(credential, { connectionId: options.connectionId });
      }
      if (!Object.keys(options).length) principals.set(cacheKey, principal);
      return principal;
    },
    async capture(unit = 'A1', options = {}) {
      const principal = Object.hasOwn(options, 'principal') ? options.principal : await h.principal(unit);
      const channel = options.channel || context.roomKey;
      const source = createPttTransmission(principal, { channelId: channel, source: options.source || 'socket', captureStartedAt: Date.now() });
      const metadata = Object.hasOwn(options, 'metadata') ? options.metadata : bindPttTransmission(source, binding);
      const accepted = await runtime.handlePttStart(channel, unit, false, metadata);
      return { unit, channel, principal, source, metadata, accepted };
    },
    frame(capture, payload = Buffer.from([7, 8])) {
      const listener = listeners.get(capture.channel);
      expect(typeof listener).toBe('function');
      listener({ unitId: capture.unit, opusPayload: payload, codec: 'opus' });
    },
    end(capture, text, options = {}) {
      if (text !== undefined) sttReplies.push(text);
      const sourceEnd = finishPttTransmission(capture.source);
      const metadata = Object.hasOwn(options, 'metadata') ? options.metadata : bindPttTransmission(sourceEnd, binding);
      const turn = observe(runtime.handlePttEnd(capture.channel, capture.unit, false, metadata));
      turn.capture = capture;
      turn.metadata = metadata;
      turns.push(turn);
      return turn;
    },
    async begin(text, unit = 'A1') {
      const capture = await h.capture(unit);
      expect(capture.accepted).toBe(true);
      h.frame(capture);
      return h.end(capture, text);
    },
    async send(text, unit = 'A1') { return finish(await h.begin(text, unit)); },
    async lastPlan() { return runtime.planner.plan.mock.results.at(-1)?.value; },
    async lastResult() { return runtime.executor.execute.mock.results.at(-1)?.value; },
    async close() {
      for (const pending of deferreds) pending.resolve(pending.fallback);
      await until(() => turns.every((turn) => turn.settled), 'fixture cleanup', 1500);
      await runtime.stop();
      for (const { id, credential } of credentials) {
        credentialDatabase.sessions.delete(credential);
        credentialDatabase.radios.delete(credential);
        credentialDatabase.accounts.delete(id);
        credentialDatabase.grants.delete(id);
      }
      expect(turns.map((turn) => turn.error).filter(Boolean)).toEqual([]);
      expect(faults).toEqual([]);
    },
  };
  await runtime.start();
  return h;
}
