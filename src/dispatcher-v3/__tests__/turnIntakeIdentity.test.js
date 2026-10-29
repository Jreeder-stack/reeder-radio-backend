import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited in identity tests'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited in identity tests'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model client prohibited'); } } }));

import * as materializer from '../planMaterializer.js';
import * as responseComposer from '../responseComposer.js';
import { bindPttTransmission, createPttTransmission, finishPttTransmission } from '../../services/pttProvenance.js';
import { START_TIME, createHarness, finish, plan, until } from './helpers/auditRuntimeHarness.js';

let harnesses;
let networkGuard;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-model-no-network');
  networkGuard = vi.fn(() => { throw new Error('Unexpected external network request'); });
  vi.stubGlobal('fetch', networkGuard);
  harnesses = [];
});

afterEach(async () => {
  try {
    for (const h of harnesses) await h.close();
    expect(networkGuard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

async function make(options) {
  const h = await createHarness(options);
  harnesses.push(h);
  return h;
}

function transcribedEnvelopes(h) {
  return h.transcribe.mock.calls.map(([, options]) => options?.turnEnvelope);
}

function diagnostic(h, phase) {
  return h.diagnostics.record.mock.calls.map(([event]) => event).filter((event) => event.phase === phase);
}

describe('01-02 immutable authenticated turns through actual runtime entry points', () => {
  it('keeps one finalized envelope through transcription, planning, materialization, execution, response and output', async () => {
    const h = await make();
    const materialize = vi.spyOn(materializer, 'materializeV3Plan');
    const compose = vi.spyOn(responseComposer, 'composeV3Response');
    // Observe the real handler; all HTTP writes and verification still execute.
    const handler = vi.fn(h.runtime.executor.handlers.get('SET_UNIT_STATUS'));
    h.runtime.executor.register('SET_UNIT_STATUS', handler);
    const capture = await h.capture('A1');
    expect(capture.accepted).toBe(true);
    h.frame(capture);
    await vi.advanceTimersByTimeAsync(17);
    await finish(h.end(capture, 'Central, available'));

    const envelope = transcribedEnvelopes(h)[0];
    expect(envelope).toMatchObject({
      runtimeId: h.context.runtimeId, profileId: h.context.profileId,
      dispatchCenterId: h.context.dispatchCenterId, channelId: h.context.channelId,
      roomKey: h.context.roomKey, accountId: capture.principal.accountId,
      connectionId: capture.principal.connectionId, credentialType: 'session',
      speakerRef: 'A1', transmissionId: capture.source.transmissionId,
      intakeSequence: 1, captureStartedAt: START_TIME.getTime(), captureEndedAt: START_TIME.getTime() + 17,
      speaker: { unitId: 'center-a-A1', callsign: 'A1', dispatchCenterId: 'center-a' },
    });
    expect(envelope.turnId).toEqual(expect.any(String));
    expect(envelope.runtimeGeneration).toEqual(expect.any(String));
    expect(envelope.identity.turnId).toBe(envelope.turnId);
    expect(h.runtime.speech.startTransmission.mock.calls[0][0].turnIdentity).toBe(envelope.identity);
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.identity)).toBe(true);
    expect(Object.isFrozen(envelope.speaker)).toBe(true);
    expect(() => { envelope.speaker.unitId = 'center-a-B2'; }).toThrow();
    expect(() => { envelope.identity.connectionId = 'forged'; }).toThrow();
    expect(h.runtime.planner.plan.mock.calls[0][0].turnEnvelope).toBe(envelope);
    expect(materialize.mock.calls[0][1].turnEnvelope).toBe(envelope);
    expect(h.runtime.executor.execute.mock.calls[0][1].turnEnvelope).toBe(envelope);
    expect(handler.mock.calls[0][0].turnEnvelope).toBe(envelope);
    expect((await h.lastResult()).turnEnvelope).toBe(envelope);
    expect(compose.mock.calls[0][0].turnEnvelope).toBe(envelope);
    expect(h.runtime._speak.mock.calls[0][2]).toBe(envelope);
    for (const phase of ['stt_completed', 'intent_planned_deterministic', 'action_received', 'action_completed', 'speech_transmitted']) {
      expect(diagnostic(h, phase).some((event) => event.turnEnvelope === envelope), phase).toBe(true);
    }
    expect(h.writes('/api/radio/status').map((request) => request.body)).toEqual([{ unit_id: 'A1', status: 'available' }]);
    expect(JSON.stringify(envelope)).not.toContain('synthetic-credential-');
  });

  it('uses an assigned radio account and its server-read channel grant', async () => {
    const h = await make();
    const principal = await h.principal('B2', { credentialType: 'radio-token', connectionId: 'radio-socket-2' });
    const capture = await h.capture('B2', { principal, source: 'radio' });
    expect(capture.accepted).toBe(true);
    h.frame(capture);
    await finish(h.end(capture, 'Central, available'));
    expect(transcribedEnvelopes(h)[0]).toMatchObject({ credentialType: 'radio-token', accountId: principal.accountId,
      connectionId: 'radio-socket-2', speaker: { callsign: 'B2', unitId: 'center-a-B2' } });
    expect(h.writes('/api/radio/status')[0].body.unit_id).toBe('B2');
  });

  it('allocates sequence before asynchronous speaker resolution finishes', async () => {
    const h = await make();
    const lookup = h.hold(undefined);
    h.cad.resolveWaits.set('A1', lookup.promise);
    const first = await h.capture('A1');
    h.frame(first);
    const firstEnd = h.end(first, 'Central, available');
    await until(() => h.cad.requests.some((request) => request.query.unit_ref === 'A1'), 'first speaker lookup');
    // Queue STT responses in invocation order: B2 resolves first.
    h.sttReplies.length = 0;
    const second = await h.capture('B2');
    h.frame(second);
    await finish(h.end(second, 'Central, available'));
    h.sttReplies.push('Central, available');
    lookup.resolve();
    await finish(firstEnd);
    const envelopes = transcribedEnvelopes(h);
    expect(envelopes.map((turn) => [turn.speakerRef, turn.intakeSequence])).toEqual([['B2', 2], ['A1', 1]]);
    expect(new Set(envelopes.map((turn) => turn.turnId)).size).toBe(2);
  });

  it('reserves execution in intake order despite reversed STT completion', async () => {
    const h = await make();
    const stt = h.hold('Central, en route');
    const first = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'first STT');
    const second = await h.begin('Central, available');
    await until(() => h.transcribe.mock.calls.length === 2, 'second STT');
    expect(h.writes('/api/radio/status')).toHaveLength(0);
    stt.resolve('Central, en route');
    await finish(first);
    await finish(second);
    const envelopes = transcribedEnvelopes(h);
    expect(envelopes.map((turn) => turn.intakeSequence)).toEqual([1, 2]);
    expect(envelopes[0].turnId).not.toBe(envelopes[1].turnId);
    expect(h.runtime.planner.plan.mock.calls.map(([input]) => input.turnEnvelope.intakeSequence)).toEqual([1, 2]);
    expect(h.writes('/api/radio/status').map((request) => request.body.status)).toEqual(['en_route', 'available']);
  });

  it('suppresses a repeated start without replacing captured audio or allocating another turn', async () => {
    const h = await make();
    const capture = await h.capture();
    h.frame(capture);
    expect(await h.runtime.handlePttStart(capture.channel, capture.unit, false, capture.metadata)).toBe(false);
    await finish(h.end(capture, 'Central, available'));
    expect(h.runtime.speech.startTransmission).toHaveBeenCalledTimes(1);
    expect(h.transcribe.mock.calls[0][0]).toHaveLength(640);
    await h.send('Central, en route');
    expect(transcribedEnvelopes(h).map((turn) => turn.intakeSequence)).toEqual([1, 2]);
    expect(h.writes('/api/radio/status')).toHaveLength(2);
  });

  it('suppresses duplicate end while transcription is still pending and after completion', async () => {
    const h = await make();
    const stt = h.hold('Central, available');
    const turn = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'pending STT');
    expect(await h.runtime.handlePttEnd(turn.capture.channel, 'A1', false, turn.metadata)).toBe(false);
    stt.resolve('Central, available');
    await finish(turn);
    expect(await h.runtime.handlePttEnd(turn.capture.channel, 'A1', false, turn.metadata)).toBe(false);
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
  });

  it('rejects an internally replayed completed start with the original transmission identity', async () => {
    const h = await make();
    const turn = await h.begin('Central, available');
    await finish(turn);
    expect(await h.runtime.handlePttStart(turn.capture.channel, 'A1', false, turn.capture.metadata)).toBe(false);
    expect(h.runtime.speech.startTransmission).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
  });

  it('rejects a completed source replay after bounded history eviction while accepting a genuinely new source', async () => {
    const h = await make();
    const original = await h.begin('Central, available');
    await finish(original);
    // Model the bounded index evicting this old ID without generating 2,049
    // unrelated turns. The issuer still knows this retained source object ended.
    h.runtime._seenTransmissions.clear();
    expect(await h.runtime.handlePttStart(original.capture.channel, 'A1', false, original.capture.metadata)).toBe(false);
    expect(h.runtime.speech.startTransmission).toHaveBeenCalledTimes(1);
    await h.send('Central, en route');
    expect(h.transcribe).toHaveBeenCalledTimes(2);
    expect(h.writes('/api/radio/status').map((request) => request.body.status)).toEqual(['available', 'en_route']);
    expect(transcribedEnvelopes(h)[0].transmissionId).not.toBe(transcribedEnvelopes(h)[1].transmissionId);
  });

  it('keeps an old end from consuming or removing a newer capture for the same callsign', async () => {
    const h = await make();
    const old = await h.begin('Central, en route');
    await finish(old);
    const current = await h.capture();
    h.frame(current);
    expect(await h.runtime.handlePttEnd(current.channel, 'A1', false, old.metadata)).toBe(false);
    await finish(h.end(current, 'Central, available'));
    expect(h.writes('/api/radio/status').map((request) => request.body.status)).toEqual(['en_route', 'available']);
    expect(transcribedEnvelopes(h).map((turn) => turn.transmissionId)).toEqual([old.capture.source.transmissionId, current.source.transmissionId]);
  });

  it('preserves an old drained completion timestamp and the newer same-connection capture', async () => {
    const h = await make();
    const old = await h.capture();
    h.frame(old);
    await vi.advanceTimersByTimeAsync(10);
    const oldSourceEnd = finishPttTransmission(old.source);
    await vi.advanceTimersByTimeAsync(10);
    const current = await h.capture();
    expect(current.accepted).toBe(true);
    // During overlap, legacy unitId-only frames are ambiguous and must drop.
    h.frame(current);
    await finish(h.end(old, 'Central, en route', { metadata: bindPttTransmission(oldSourceEnd, h.binding) }));
    h.frame(current);
    await finish(h.end(current, 'Central, available'));
    const envelopes = transcribedEnvelopes(h);
    expect(envelopes.map((turn) => turn.transmissionId)).toEqual([old.source.transmissionId, current.source.transmissionId]);
    expect(envelopes[0].captureEndedAt).toBe(START_TIME.getTime() + 10);
    expect(envelopes[1].captureStartedAt).toBe(START_TIME.getTime() + 20);
    expect(h.transcribe.mock.calls.map(([pcm]) => pcm.length)).toEqual([640, 640]);
    expect(h.writes('/api/radio/status').map((request) => request.body.status)).toEqual(['en_route', 'available']);
  });

  it('preserves separate connection identities when the same callsign transmits sequentially', async () => {
    const h = await make();
    const firstPrincipal = await h.principal('A1', { connectionId: 'connection-one' });
    const secondPrincipal = await h.principal('A1', { accountId: firstPrincipal.accountId, connectionId: 'connection-two' });
    for (const principal of [firstPrincipal, secondPrincipal]) {
      const capture = await h.capture('A1', { principal });
      h.frame(capture);
      await finish(h.end(capture, 'Central, available'));
    }
    expect(transcribedEnvelopes(h).map((turn) => turn.connectionId)).toEqual(['connection-one', 'connection-two']);
    expect(new Set(transcribedEnvelopes(h).map((turn) => turn.turnId)).size).toBe(2);
  });

  it('invalidates overlapping connections sharing a callsign because unlabelled audio cannot prove its source', async () => {
    const h = await make();
    const firstPrincipal = await h.principal('A1', { connectionId: 'connection-one' });
    const secondPrincipal = await h.principal('A1', { accountId: firstPrincipal.accountId, connectionId: 'connection-two' });
    const first = await h.capture('A1', { principal: firstPrincipal });
    h.frame(first);
    const overlapping = await h.capture('A1', { principal: secondPrincipal });
    expect(overlapping.accepted).toBe(false);
    // Both connections can emit legacy unitId-only frames. Keeping the older
    // capture would allow the newer sender's audio to inherit its authority.
    expect(await finish(h.end(first))).toBe(false);
    expect(await finish(h.end(overlapping))).toBe(false);
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it('keeps a callsign blocked through every ambiguous connection end before accepting a clean capture', async () => {
    const h = await make();
    const firstPrincipal = await h.principal('A1', { connectionId: 'connection-one' });
    const secondPrincipal = await h.principal('A1', { accountId: firstPrincipal.accountId, connectionId: 'connection-two' });
    const thirdPrincipal = await h.principal('A1', { accountId: firstPrincipal.accountId, connectionId: 'connection-three' });
    const first = await h.capture('A1', { principal: firstPrincipal });
    expect(first.accepted).toBe(true);
    h.frame(first);
    const second = await h.capture('A1', { principal: secondPrincipal });
    const third = await h.capture('A1', { principal: thirdPrincipal });
    expect(second.accepted).toBe(false);
    expect(third.accepted).toBe(false);
    // Frames from any of the unresolved sources share the same wire callsign.
    h.frame(first);
    h.frame(third);
    expect(await finish(h.end(first))).toBe(false);
    expect(await finish(h.end(second))).toBe(false);
    expect(await finish(h.end(third))).toBe(false);
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);

    const clean = await h.capture('A1', { principal: firstPrincipal });
    expect(clean.accepted).toBe(true);
    h.frame(clean);
    await finish(h.end(clean, 'Central, available'));
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.transcribe.mock.calls[0][0]).toHaveLength(640);
    expect(transcribedEnvelopes(h)[0].transmissionId).toBe(clean.source.transmissionId);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
  });

  it('isolates identical callsigns and channel names across configured centers', async () => {
    const first = await make({ center: 'north' });
    const second = await make({ center: 'south' });
    await first.send('Central, available');
    await second.send('Central, en route');
    const a = transcribedEnvelopes(first)[0];
    const b = transcribedEnvelopes(second)[0];
    expect(a.speaker.unitId).toBe('north-A1');
    expect(b.speaker.unitId).toBe('south-A1');
    expect(a.dispatchCenterId).not.toBe(b.dispatchCenterId);
    expect(a.connectionId).not.toBe(b.connectionId);
    expect(a.runtimeGeneration).not.toBe(b.runtimeGeneration);
    expect(first.cad.requests.every((request) => request.center === 'north')).toBe(true);
    expect(second.cad.requests.every((request) => request.center === 'south')).toBe(true);
  });

  it('creates a new runtime generation after ordinary stop/start', async () => {
    const h = await make();
    await h.send('Central, available');
    const previous = transcribedEnvelopes(h)[0];
    await h.runtime.stop();
    await h.runtime.start();
    await h.send('Central, en route');
    const current = transcribedEnvelopes(h)[1];
    expect(current.runtimeGeneration).not.toBe(previous.runtimeGeneration);
    expect(current.turnId).not.toBe(previous.turnId);
    expect(current.speaker.unitId).toBe(previous.speaker.unitId);
    expect(h.writes('/api/radio/status')).toHaveLength(2);
  });
});

describe('01-02 missing or ambiguous ownership never authorizes CAD actions', () => {
  it.each([
    ['missing metadata', null],
    ['client-authenticated boolean', { authenticated: true, unitId: 'A1', accountId: '1', channelId: 'channel-center-a' }],
  ])('rejects %s before speech capture or action processing', async (_label, metadata) => {
    const h = await make({ llmPlans: [plan('SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' })] });
    expect((await h.capture('A1', { metadata })).accepted).toBe(false);
    expect(h.runtime.speech.startTransmission).not.toHaveBeenCalled();
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it('rejects a serialized copy of genuine metadata because JSON cannot retain issuer proof', async () => {
    const h = await make();
    const source = createPttTransmission(await h.principal(), { channelId: h.context.roomKey, source: 'socket' });
    const metadata = bindPttTransmission(source, h.binding);
    expect((await h.capture('A1', { metadata: structuredClone(metadata) })).accepted).toBe(false);
    expect(h.runtime.speech.startTransmission).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it('does not accept a source principal without an account-owned channel grant', async () => {
    const h = await make();
    const principal = await h.principal('A1', { grants: [] });
    expect((await h.capture('A1', { principal })).accepted).toBe(false);
    expect(h.writes()).toEqual([]);
  });

  it('rejects a valid principal bound to a different configured center', async () => {
    const h = await make();
    const source = createPttTransmission(await h.principal(), { channelId: h.context.roomKey, source: 'socket' });
    const foreign = bindPttTransmission(source, { ...h.binding, dispatchCenterId: 'other-center' });
    expect((await h.capture('A1', { metadata: foreign })).accepted).toBe(false);
    expect(h.writes()).toEqual([]);
  });

  it('rejects an event callsign that differs from the authenticated account', async () => {
    const h = await make();
    const principal = await h.principal('A1');
    expect((await h.capture('B2', { principal })).accepted).toBe(false);
    expect(h.writes()).toEqual([]);
  });

  it.each(['missingUnits', 'ambiguousUnits'])('cannot substitute a resolvable requested target when the authenticated actor is %s', async (fault) => {
    const h = await make({ llmPlans: [plan('SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' })] });
    h.cad[fault].add('A1');
    const capture = await h.capture('A1');
    expect(capture.accepted).toBe(true);
    h.frame(capture);
    expect(await finish(h.end(capture, 'Central, mark B2 available'))).toBe(false);
    expect(h.transcribe).not.toHaveBeenCalled();
    expect(h.runtime.planner.plan).not.toHaveBeenCalled();
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
    const terminal = diagnostic(h, 'turn_completed').at(-1);
    expect(terminal?.turnEnvelope).toMatchObject({ speaker: null, speakerRef: 'A1', transmissionId: capture.source.transmissionId });
  });

  it('keeps the authenticated speaker A1 while the explicit requested target is B2', async () => {
    const h = await make();
    await h.send('Central, mark B2 available', 'A1');
    const envelope = transcribedEnvelopes(h)[0];
    expect(envelope.speaker).toMatchObject({ callsign: 'A1', unitId: 'center-a-A1' });
    expect(h.runtime.executor.execute.mock.calls[0][0].input.unitId).toBe('center-a-B2');
    expect(h.writes('/api/radio/status')[0].body.unit_id).toBe('B2');
  });

  it('ignores model-supplied actor and envelope fields while preserving a permitted target', async () => {
    const h = await make({ llmPlans: [{
      ...plan('SET_UNIT_STATUS', { unitRef: 'B2', status: 'available' }),
      speakerCallsign: 'B2', accountId: 'forged-account',
      turnEnvelope: { speaker: { unitId: 'center-a-B2', callsign: 'B2' }, authenticated: true },
    }] });
    await h.send('Central, please apply the previously requested change for B2', 'A1');
    expect(h.llm).toHaveBeenCalledTimes(1);
    const envelope = transcribedEnvelopes(h)[0];
    expect(envelope.speaker.callsign).toBe('A1');
    expect(h.runtime.executor.execute.mock.calls[0][1].turnEnvelope).toBe(envelope);
    expect(h.runtime.executor.execute.mock.calls[0][0].input.unitId).toBe('center-a-B2');
    expect(h.writes('/api/radio/status')[0].body.unit_id).toBe('B2');
  });

  it('carries the same originating envelope through every operation of a compound request', async () => {
    const h = await make({ llmPlans: [{ confidence: 1, actions: [
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'en_route' } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'B2', status: 'available' } },
    ] }] });
    await h.send('Central, mark me en route and mark B2 available', 'A1');
    const envelope = transcribedEnvelopes(h)[0];
    expect(h.runtime.executor.execute).toHaveBeenCalledTimes(2);
    for (const [, options] of h.runtime.executor.execute.mock.calls) expect(options.turnEnvelope).toBe(envelope);
    for (const result of h.runtime.executor.execute.mock.results) expect((await result.value).turnEnvelope).toBe(envelope);
    expect(h.writes('/api/radio/status').map((request) => request.body.unit_id)).toEqual(['A1', 'B2']);
    expect(h.runtime._speak.mock.calls[0][2]).toBe(envelope);
  });

  it('cannot gain write permission by speaking another callsign', async () => {
    const h = await make({ scopes: ['unit.read', 'call.read'] });
    await h.send('Central, mark B2 available', 'A1');
    expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
    expect((await h.lastResult()).turnEnvelope.speaker.callsign).toBe('A1');
    expect(h.writes()).toEqual([]);
  });

  it('requires genuine envelope proof at the runtime executor even when a target is already resolved', async () => {
    const h = await make();
    await h.send('Central, radio check');
    const envelope = transcribedEnvelopes(h)[0];
    const request = { action: 'SET_UNIT_STATUS', input: { unitId: 'center-a-B2', status: 'available' } };
    const missing = await h.runtime.executor.execute(request);
    const forged = await h.runtime.executor.execute(request, { turnEnvelope: structuredClone(envelope) });
    const requestClaim = await h.runtime.executor.execute({ ...request, turnEnvelope: envelope });
    expect(missing).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(forged).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(requestClaim).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(h.writes()).toEqual([]);
  });

  it('does not allow a plain end event to consume an authenticated capture', async () => {
    const h = await make();
    const capture = await h.capture();
    h.frame(capture);
    expect(await h.runtime.handlePttEnd(capture.channel, capture.unit)).toBe(false);
    await finish(h.end(capture, 'Central, available'));
    expect(h.transcribe).toHaveBeenCalledTimes(1);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
  });
});

describe('01-02 terminal paths retain capture ownership', () => {
  it('retains the frozen finalized envelope for an empty capture', async () => {
    const h = await make();
    const capture = await h.capture();
    await vi.advanceTimersByTimeAsync(12);
    expect(await finish(h.end(capture))).toBe(false);
    expect(h.transcribe).not.toHaveBeenCalled();
    const empty = diagnostic(h, 'ptt_empty').at(-1);
    const terminal = diagnostic(h, 'turn_completed').at(-1);
    expect(empty?.turnEnvelope).toMatchObject({ transmissionId: capture.source.transmissionId,
      captureStartedAt: START_TIME.getTime(), captureEndedAt: START_TIME.getTime() + 12 });
    expect(terminal?.turnEnvelope).toBe(empty.turnEnvelope);
    expect(Object.isFrozen(empty.turnEnvelope)).toBe(true);
    expect(h.writes()).toEqual([]);
  });

  it('retains capture identity when STT fails without allowing an action', async () => {
    const h = await make();
    const stt = h.hold('Central, available');
    const turn = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'failing STT');
    stt.reject(new Error('synthetic STT failure'));
    expect(await finish(turn)).toBe(false);
    const envelope = transcribedEnvelopes(h)[0];
    expect(diagnostic(h, 'stt_failed').at(-1)?.turnEnvelope).toBe(envelope);
    expect(diagnostic(h, 'turn_completed').at(-1)?.turnEnvelope).toBe(envelope);
    expect(h.runtime.executor.execute).not.toHaveBeenCalled();
    expect(h.writes()).toEqual([]);
  });

  it('retains the originating turn when output fails after a verified action', async () => {
    const h = await make();
    const speech = h.hold(Buffer.alloc(640));
    h.synthesisReplies.push(speech.promise);
    const turn = await h.begin('Central, available');
    await until(() => h.synthesize.mock.calls.length === 1, 'failing synthesis');
    speech.reject(new Error('synthetic TTS failure'));
    await finish(turn);
    const envelope = transcribedEnvelopes(h)[0];
    expect((await h.lastResult()).data.verified).toBe(true);
    expect(diagnostic(h, 'speech_transmit_failed').at(-1)?.turnEnvelope).toBe(envelope);
    expect(diagnostic(h, 'turn_completed').at(-1)?.turnEnvelope).toBe(envelope);
    expect(h.floor.releaseFloor).toHaveBeenCalledTimes(1);
  });
});
