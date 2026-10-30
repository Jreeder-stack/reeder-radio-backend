import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Block module-level integrations before importing the actual runtime.
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Live STT prohibited in audit tests'); },
  textToSpeech: () => { throw new Error('Live TTS prohibited in audit tests'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Live paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model client prohibited'); } } }));

import { CommandLinkGateway } from '../cadGateway.js';
import { BASE_SHA, START_TIME, NO_ACTION, createHarness, finish, observe, plan, until } from './helpers/auditRuntimeHarness.js';

const mode = process.env.DISPATCHER_AUDIT_MODE || 'baseline';
if (!['baseline', 'acceptance'].includes(mode)) throw new Error(`Unknown DISPATCHER_AUDIT_MODE: ${mode}`);
const ledger = [];
// Repaired cases must assert the fixed behavior in EVERY mode. Unrepaired
// cases retain their pinned baseline until their owning work item is finished.
const repairedCases = new Set(['R01', 'R02', 'R03', 'R04', 'R06', 'R07', 'R09', 'R10', 'R11', 'R12']);
let harnesses = [];
let networkGuard;

async function make(options) { const h = await createHarness(options); harnesses.push(h); return h; }

// Baseline asserts the *specific observed defect*, not an arbitrary thrown error.
// Acceptance asserts the required repaired behavior and deliberately fails on the audited revision.
function record(id, finding, expectedFixedBehavior, observed, baseline, repaired) {
  const repairAcceptancePassed = repaired(observed);
  const assertionMode = mode === 'acceptance' || repairedCases.has(id) ? 'acceptance' : 'baseline';
  ledger.push({ id, finding, expectedFixedBehavior, observed, repairAcceptancePassed, mode: assertionMode });
  if (assertionMode === 'acceptance') expect(repairAcceptancePassed, `${id}: ${expectedFixedBehavior}`).toBe(true);
  else expect(observed, `${id}: baseline changed; inspect before crediting a repair`).toEqual(baseline);
}

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

afterAll(() => {
  const reportPath = process.env.DISPATCHER_AUDIT_REPORT;
  if (!reportPath) return;
  const sourcePaths = [
    'src/dispatcher-v3/liveRuntime.js', 'src/dispatcher-v3/conversationRecords.js', 'src/dispatcher-v3/speechPipeline.js',
    'src/dispatcher-v3/conversationGate.js', 'src/dispatcher-v3/intentPlanner.js',
    'src/dispatcher-v3/deterministicIntent.js', 'src/dispatcher-v3/fieldIncidentCoordinator.js',
    'src/dispatcher-v3/operationalContext.js', 'src/dispatcher-v3/actionExecutor.js',
    'src/dispatcher-v3/responseComposer.js', 'src/dispatcher-v3/cadGateway.js',
    'src/services/azureSpeechService.js', 'src/services/aiDispatcherRuntimeManager.js', 'package-lock.json',
    'src/dispatcher-v3/turnEnvelope.js', 'src/services/pttProvenance.js',
    'src/services/signalingService.js', 'src/services/signalingFloorIdentityHardening.js',
    'src/routes/pttRoutes.js', 'src/controllers/dispatchController.js',
    'src/services/aiDispatchService.js', 'src/services/aiDispatcherSignaling.js',
  ];
  const sourceBlobs = Object.fromEntries(sourcePaths.map((path) => {
    const content = readFileSync(path);
    return [path, createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex')];
  }));
  // Sandboxed test runners may prohibit child processes. The caller can supply
  // the independently verified checkout revision; source hashes still record
  // the actual bytes tested, including uncommitted implementation changes.
  const testedRevision = process.env.DISPATCHER_AUDIT_REVISION
    || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!/^[a-f0-9]{40}$/.test(testedRevision)) throw new Error('Audit revision must be a complete commit SHA');
  const report = {
    task: 'AI-DISP-V3-001/01-01', historicalBaseline: BASE_SHA,
    testedRevision,
    revisionSource: process.env.DISPATCHER_AUDIT_REVISION ? 'caller_verified_checkout' : 'git_checkout',
    runtime: process.version, platform: `${process.platform}/${process.arch}`, mode,
    generatedAt: new Date().toISOString(), sourceBlobs,
    expectedReproductions: 14, recordedReproductions: ledger.length,
    requiredRepairedCases: [...repairedCases],
    allReproductionsRecorded: new Set(ledger.map((entry) => entry.id)).size === 14,
    repairAcceptancePassed: ledger.length === 14 && ledger.every((entry) => entry.repairAcceptancePassed),
    productionWrites: 0, radioTransmissions: 0, paidProviderCalls: 0,
    note: 'Mixed progress evidence: requiredRepairedCases always assert fixed behavior; other baseline cases still reproduce defects. Consult the Vitest result for fixture/control failures. This is not release acceptance.',
    reproductions: [...ledger].sort((a, b) => a.id.localeCompare(b.id)),
  };
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});

describe('01-01 audit regressions: repaired assertions plus remaining known defects', () => {
  it('R01: stale dialogue crosses speakers and loses attribution in the model payload', async () => {
    const h = await make({ llmPlans: [
      { ...plan('CLARIFY', { callId: 'OLD-CALL' }), clarification: 'Which address should I use?' }, NO_ACTION,
    ] });
    await h.send('Central, please consider the address information I mentioned earlier');
    await vi.advanceTimersByTimeAsync(360000);
    await h.send('Central, could you explain the next task I should consider', 'B2');
    expect(h.llm).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(h.llm.mock.calls[1][0].messages[1].content);
    const foreign = payload.recentContext.find((item) => item.input?.callId === 'OLD-CALL');
    const observed = { foreignDialoguePresent: Boolean(foreign), hasSpeaker: Boolean(foreign?.speakerCallsign || foreign?.unitId), hasAge: Boolean(foreign?.timestamp || foreign?.capturedAt) };
    // 02-01 now deliberately requires the stronger invariant: B2 sees no
    // A1 dialogue, even when the previous context entry has expired.
    expect(payload.recentContext).toEqual([]);
    record('R01', 'F1', 'Expired A1 dialogue must not be supplied as B2 current conversation.', observed,
      { foreignDialoguePresent: true, hasSpeaker: false, hasAge: false }, (o) => !o.foreignDialoguePresent);
  });

  it('R02: later transcription overtakes earlier speech', async () => {
    const h = await make();
    const first = h.hold('Central, en route');
    const older = await h.begin(first.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'first transcription');
    const newer = await h.begin('Central, available');
    await vi.advanceTimersByTimeAsync(100);
    first.resolve('Central, en route');
    await finish(older); await finish(newer);
    const observed = h.writes('/api/radio/status').map((request) => request.body.status);
    record('R02', 'F2', 'Legitimate consecutive statuses must execute in capture order.', observed,
      ['available', 'en_route'], (o) => JSON.stringify(o) === JSON.stringify(['en_route', 'available']));
  });

  it('R03: an answer queued while valid executes after the disposition expires', async () => {
    const h = await make(); h.cad.current.set('A1', 'OLD-CALL');
    const speech = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(speech.promise);
    const question = await h.begin('Central, clear me from my call');
    await until(() => h.synthesize.mock.calls.length === 1, 'disposition question synthesis');
    const pending = h.runtime.conversationGate.pending.get('A1');
    expect(pending.kind).toBe('disposition');
    const answer = await h.begin('report taken');
    await until(() => h.transcribe.mock.calls.length === 2, 'disposition answer transcription');
    await vi.advanceTimersByTimeAsync(300000);
    speech.resolve(Buffer.alloc(640)); await finish(question); await finish(answer);
    const expiredWrites = h.writes('/api/radio/dispose').filter((request) => request.at > pending.expiresAt);
    const observed = { expiredWrite: expiredWrites.length > 0, target: expiredWrites[0]?.body.call_id || null };
    record('R03', 'F2', 'An expired pending answer must be revalidated and must not mutate its old call.', observed,
      { expiredWrite: true, target: 'OLD-CALL' }, (o) => !o.expiredWrite);
  });

  it('R04: a transcription finishing after stop can still mutate CAD', async () => {
    const h = await make(); const stt = h.hold('Central, available');
    const turn = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'pending STT');
    await h.runtime.stop(); const stoppedAt = Date.now();
    stt.resolve('Central, available'); await finish(turn);
    const observed = { running: h.runtime.isRunning, postStopWrites: h.writes().filter((request) => request.at >= stoppedAt).length };
    record('R04', 'F2', 'Stopped generations cannot issue late mutations or speech.', observed,
      { running: false, postStopWrites: 1 }, (o) => !o.running && o.postStopWrites === 0);
  });

  it('R05: cancellation is appended to an old incident after reassignment', async () => {
    const h = await make({ llmPlans: [plan('REPORT_FIELD_INCIDENT', { unitRef: 'A1', eventType: 'officer_assist', note: 'Subject moving away' }), NO_ACTION] });
    h.cad.current.set('A1', 'OLD-CALL');
    await h.send('Central, document this field observation about a departing subject');
    expect(h.runtime.fieldIncidents.getDialogueContext('A1')?.callId).toBe('OLD-CALL');
    h.cad.current.set('A1', 'NEW-CALL');
    await h.send('Central, disregard the previous request');
    const mistaken = h.writes('/api/radio/note').filter((request) => request.body.note.includes('disregard'));
    const observed = { cancellationWritten: mistaken.length > 0, target: mistaken[0]?.body.call_id || null, currentCall: h.cad.current.get('A1') };
    record('R05', 'F4', 'Cancellation must retire the intended dialogue, not become an old-call note.', observed,
      { cancellationWritten: true, target: 'OLD-CALL', currentCall: 'NEW-CALL' }, (o) => !o.cancellationWritten);
  });

  it('R06: negations and a question reach semantics without contrary writes', async () => {
    const h = await make({ llmPlans: [NO_ACTION, plan('STATUS_CHECK', { unitRef: 'B2' }), NO_ACTION] });
    for (const words of ['do not mark B2 available', 'is B2 available?', 'B2 is not on scene']) await h.send(`Central, ${words}`);
    const observed = { writes: h.writes('/api/radio/status').map((request) => [request.body.unit_id, request.body.status]), modelCalls: h.llm.mock.calls.length };
    record('R06', 'F5', 'Negations and questions must not produce the opposite mutation.', observed,
      { writes: [['B2', 'available'], ['B2', 'available'], ['B2', 'on_scene']], modelCalls: 0 }, (o) => o.writes.length === 0 && o.modelCalls === 3);
    expect(h.runtime.executor.execute.mock.calls.map(([request]) => request.action)).toEqual(['STATUS_CHECK']);
    expect((await h.lastResult()).success).toBe(true);
  });

  it('R07: semantic planning preserves both commands and the clean address', async () => {
    const h = await make({ llmPlans: [{ confidence: 1, actions: [
      { action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main Street', unitRefs: ['A1'] } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'on_scene' } },
    ] }] });
    await h.send('Central, start a building check at 100 Main Street and mark me on scene');
    const planned = await h.lastPlan();
    const actions = planned.actions || [planned];
    const observed = { actions: actions.map((item) => item.action), location: actions[0].input.location };
    record('R07', 'F5', 'Keep the address separate and preserve both requested operations.', observed,
      { actions: ['CREATE_CALL'], location: '100 Main Street and mark me on scene' },
      (o) => o.location === '100 Main Street' && o.actions.includes('CREATE_CALL') && o.actions.includes('SET_UNIT_STATUS'));
    expect(h.llm).toHaveBeenCalledTimes(1);
    expect(h.writes().map((request) => request.path)).toEqual(['/api/radio/v3/cad/calls', '/api/radio/status']);
    for (const result of h.runtime.executor.execute.mock.results) expect(await result.value).toMatchObject({ success: true, data: { verified: true } });
  });

  it('R08: successful GET_CALL and SEARCH_CALLS results receive only copy', async () => {
    const h = await make({ llmPlans: [plan('GET_CALL', { callId: 'OLD-CALL' }), plan('SEARCH_CALLS', { query: 'Walmart' })] });
    await h.send('Central, please retrieve the incident details I requested');
    const first = await h.lastResult(); expect(first.success).toBe(true); expect(first.data.call.location).toBe('Walmart');
    await h.send('Central, please search the incident records I requested');
    const second = await h.lastResult(); expect(second.success).toBe(true); expect(second.data.calls.some((call) => call.location === 'Walmart')).toBe(true);
    const observed = h.spoken();
    record('R08', 'F7', 'Read operations must speak the requested information, not a generic acknowledgment.', observed,
      ['A1, copy.', 'A1, copy.'], (o) => o.length === 2 && o.every((text) => text.includes('Walmart')));
  });

  it('R09: the CAD deadline ends at headers, leaving the response body unbounded', async () => {
    const h = await make(); const body = h.hold('{"success":true,"calls":[]}'); let signal;
    const fetchImpl = vi.fn(async (url, options) => {
      signal = options.signal;
      return { ok: true, status: 200, headers: new Headers(), text: () => new Promise((yes, no) => {
        const abort = () => no(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        signal.addEventListener('abort', abort, { once: true });
        body.promise.then(yes, no).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
      }) };
    });
    const gateway = new CommandLinkGateway(h.runtime.context, { fetchImpl, timeoutMs: 15, maxSafeRetries: 0 });
    const request = observe(gateway.get('/api/radio/calls'));
    await vi.advanceTimersByTimeAsync(45);
    const observed = { settledAtDeadline: request.settled, aborted: signal.aborted };
    body.resolve('{"success":true,"calls":[]}'); await request.done;
    record('R09', 'F3', 'A whole CAD operation, including body consumption, must have a deadline.', observed,
      { settledAtDeadline: false, aborted: false }, (o) => o.settledAtDeadline && o.aborted);
  });

  it('R10: a TTS stall blocks the next request until it is five minutes old', async () => {
    const h = await make(); const speech = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(speech.promise);
    const first = await h.begin('Central, en route');
    await until(() => h.synthesize.mock.calls.length === 1, 'first synthesis');
    const capturedAt = Date.now(); const next = await h.begin('Central, available');
    await vi.advanceTimersByTimeAsync(300000);
    const progressedBeforeRelease = next.settled;
    speech.resolve(Buffer.alloc(640)); await finish(first); await finish(next);
    const lateWrite = h.writes('/api/radio/status').some((request) => request.body.status === 'available' && request.at - capturedAt >= 300000);
    const observed = { progressedBeforeRelease, lateWrite };
    record('R10', 'F3', 'A stalled voice response must not freeze processing and later execute stale work.', observed,
      { progressedBeforeRelease: false, lateWrite: true }, (o) => o.progressedBeforeRelease && !o.lateWrite);
  });

  it('R11: the reply window expires before the question is delivered', async () => {
    const h = await make({ llmPlans: [{ ...plan('CLARIFY'), clarification: 'Which incident are you referring to?' }, NO_ACTION] });
    const speech = h.hold(Buffer.alloc(640)); h.synthesisReplies.push(speech.promise);
    const question = await h.begin('Central, please explain the assignment I mentioned earlier');
    await until(() => h.synthesize.mock.calls.length === 1, 'delayed clarification');
    // The legacy 31-second blocked-synthesis fixture exceeds 01-06's 22s
    // outbound active deadline. Exercise a genuinely delivered question
    // delayed within that bound, then answer after creation+30s but before
    // delivery+30s. This still reproduces the old creation-time expiry.
    await vi.advanceTimersByTimeAsync(10000);
    speech.resolve(Buffer.alloc(640)); await finish(question); await h.flushOutput();
    await vi.advanceTimersByTimeAsync(22000);
    const answerAccepted = await h.send('the alarm');
    const observed = { answerAccepted, modelCalls: h.llm.mock.calls.length };
    record('R11', 'F6', 'An answer immediately after a delivered question must retain its valid reply window.', observed,
      { answerAccepted: false, modelCalls: 1 }, (o) => o.answerAccepted === true);
  });

  it('R12: resolution clarification loses the structured original task', async () => {
    const h = await make({ llmPlans: [plan('ASSIGN_UNIT', { unitRef: 'A1', callRef: 'that call' })] });
    await h.send('Central, put me on that call');
    expect(h.spoken().at(-1)).toBe('A1, which call?');
    const pending = h.runtime.conversationGate.pending.get('A1');
    const observed = { originalTaskRetained: JSON.stringify(pending).includes('ASSIGN_UNIT'), inputKeys: Object.keys(pending.input || {}) };
    record('R12', 'F6', 'Clarification must retain the original action and resolved task parameters.', observed,
      { originalTaskRetained: false, inputKeys: [] }, (o) => o.originalTaskRetained);
  });

  it('R13: a failed incident-note write is labeled successful and hidden in speech', async () => {
    const h = await make({ llmPlans: [plan('REPORT_FIELD_INCIDENT', { unitRef: 'A1', eventType: 'shots_fired', note: 'shots fired' })] });
    h.cad.current.set('A1', 'OLD-CALL'); h.cad.failNotes = true;
    await h.send('Central, document this field observation about the subject');
    const result = await h.lastResult();
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    const observed = { executorSuccess: result.success, hasPartialError: result.data?.partialErrors?.length > 0,
      failureDisclosed: /unable|failed|not (?:saved|recorded)|couldn.t|pending|unavailable|unconfirmed/i.test(h.spoken().at(-1)) };
    record('R13', 'F8', 'Separate receipt from persistence and disclose failed, deferred or unconfirmed writes.', observed,
      { executorSuccess: true, hasPartialError: true, failureDisclosed: false }, (o) => o.failureDisclosed);
  });

  it('R14: a conflicting call reference selects the Walmart alarm', async () => {
    const h = await make({ llmPlans: [plan('GET_CALL', { callRef: 'Walmart robbery' })] });
    await h.send('Central, retrieve the Walmart robbery details for me');
    const request = h.runtime.executor.execute.mock.calls.at(-1)?.[0];
    const observed = { wrongCallSelected: request?.input?.callId === 'OLD-CALL', responseDelivered: h.spoken().length > 0 };
    record('R14', 'F9', 'A contradictory incident reference requires clarification rather than a weak match.', observed,
      { wrongCallSelected: true, responseDelivered: true }, (o) => !o.wrongCallSelected && o.responseDelivered);
  });
});

describe('01-01 healthy controls that repairs must preserve', () => {
  it('P01: ordinary consecutive statuses execute and are verified', async () => {
    const h = await make(); await h.send('Central, en route'); await h.send('Central, on scene');
    expect(h.writes('/api/radio/status').map((request) => request.body.status)).toEqual(['en_route', 'on_scene']);
    expect((await h.lastResult()).data.verified).toBe(true);
    expect(h.relay.injectAudio).toHaveBeenCalledTimes(2);
    expect(h.floor.releaseFloor).toHaveBeenCalledTimes(2);
  });

  it('P02: another unit can progress while A1 transcription is pending', async () => {
    const h = await make(); const stt = h.hold('Central, en route'); const a = await h.begin(stt.promise);
    await until(() => h.transcribe.mock.calls.length === 1, 'A1 STT');
    await h.send('Central, available', 'B2');
    expect(a.settled).toBe(false);
    expect(h.writes('/api/radio/status').map((request) => request.body.unit_id)).toEqual(['B2']);
    stt.resolve('Central, en route'); await finish(a);
  });

  it('P03: duplicate PTT end does not duplicate a command', async () => {
    const h = await make(); await h.send('Central, available');
    expect(await h.runtime.handlePttEnd(h.context.roomKey, 'A1')).toBe(false);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.transcribe).toHaveBeenCalledTimes(1);
  });

  it('P04: wrong-channel and self-generated input are rejected', async () => {
    const h = await make();
    expect(await h.runtime.handlePttStart('other-center__OPS1', 'A1')).toBe(false);
    expect(await h.runtime.handlePttEnd('other-center__OPS1', 'A1')).toBe(false);
    expect(await h.runtime.handlePttStart(h.context.roomKey, h.context.identity)).toBe(false);
    expect(h.transcribe).not.toHaveBeenCalled(); expect(h.writes()).toEqual([]);
  });

  it('P05: identical callsigns in separate centers use separate identities and CAD requests', async () => {
    const first = await make({ center: 'first' }); const second = await make({ center: 'second' });
    await first.send('Central, available'); await second.send('Central, en route');
    expect(first.cad.units[0].status).toBe('available'); expect(second.cad.units[0].status).toBe('en_route');
    expect(first.cad.requests.every((request) => request.center === 'first')).toBe(true);
    expect(second.cad.requests.every((request) => request.center === 'second')).toBe(true);
    expect(first.runtime.executor.execute.mock.calls[0][0].input.unitId).not.toBe(second.runtime.executor.execute.mock.calls[0][0].input.unitId);
  });

  it('P06: unaddressed routine speech does not cause a CAD write', async () => {
    const h = await make(); expect(await h.send('available')).toBe(false);
    expect(h.writes()).toEqual([]); expect(h.spoken()).toEqual([]);
  });

  it('P07: read-only scopes cannot execute a status write', async () => {
    const h = await make({ scopes: ['unit.read', 'call.read'] }); await h.send('Central, available');
    expect(h.writes()).toEqual([]); expect((await h.lastResult()).error.code).toBe('UNAUTHORIZED');
    expect(h.spoken().at(-1)).toContain("isn't authorized");
  });

  it('P08: ordinary CAD failures are not announced as successful status changes', async () => {
    const h = await make(); h.cad.failStatus = true; await h.send('Central, available');
    expect((await h.lastResult()).success).toBe(false);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.spoken().at(-1)).toContain('unable');
  });

  it('P09: a successful HTTP response still requires status read-back verification', async () => {
    const h = await make(); h.cad.ignoreStatusWrite = true; await h.send('Central, available');
    expect((await h.lastResult()).success).toBe(false);
    expect(h.cad.units[0].status).toBe('on_duty'); expect(h.spoken().at(-1)).toContain('unable');
  });

  it('P10: immediate clarification follow-ups are accepted before expiry', async () => {
    const h = await make({ llmPlans: [{ ...plan('CLARIFY'), clarification: 'Which location?' }, NO_ACTION] });
    await h.send('Central, please clarify the location I mentioned earlier');
    expect(await h.send('the west entrance')).toBe(true); expect(h.llm).toHaveBeenCalledTimes(2);
  });

  it('P11: actual PTT resumes after an ordinary stop/start with no in-flight work', async () => {
    const h = await make(); await h.runtime.stop(); await h.runtime.start(); await h.send('Central, radio check');
    expect(h.spoken()).toEqual(['A1, loud and clear.']); expect(h.writes()).toEqual([]);
  });

  it('P12: five units complete independent routine requests through PTT', async () => {
    const h = await make();
    for (const unit of ['A1', 'B2', 'C3', 'D4', 'E5']) await h.send('Central, available', unit);
    expect(h.writes('/api/radio/status').map((request) => request.body.unit_id)).toEqual(['A1', 'B2', 'C3', 'D4', 'E5']);
    expect(h.cad.units.every((unit) => unit.status === 'available')).toBe(true);
  });
});
