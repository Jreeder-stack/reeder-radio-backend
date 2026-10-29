import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw new Error('Real STT prohibited'); },
  textToSpeech: () => { throw new Error('Real TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw new Error('Real paging prohibited'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw new Error('Live model disabled'); } } }));

import { V3DiagnosticsJournal } from '../diagnostics.js';
import { createHarness, START_TIME } from './helpers/auditRuntimeHarness.js';

let harnesses, logs, logger, networkGuard;
const ACCESS = Object.freeze({ dispatchCenterId: 'center-a', runtimeId: 'audit-center-a',
  scopes: ['dispatcher.diagnostics.read'] });
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT', 'synthetic-no-network');
  networkGuard = vi.fn(() => { throw new Error('Unexpected external network'); });
  vi.stubGlobal('fetch', networkGuard);
  logs = []; logger = { info: (...args) => logs.push(args.join(' ')) };
  harnesses = [];
});
afterEach(async () => {
  try {
    for (const h of harnesses) await h.close();
    expect(networkGuard).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks();
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
  }
});
async function make() { const h = await createHarness(); harnesses.push(h); return h; }
function journal(options = {}) { return new V3DiagnosticsJournal({ logger, ...options }); }
function event(phase, details = {}, center = 'center-a') {
  return { phase, details, runtimeId: 'audit-' + center, dispatchCenterId: center, channelId: 'channel-' + center,
    correlationId: 'turn-synthetic', success: true };
}
const recent = (j, access = ACCESS, opts = {}) => j.getRecent({ access, runtimeId: access?.runtimeId, ...opts });

describe('01-07 bounded, redacted, center-scoped diagnostics', () => {
  it('does not log, retain or expose raw transcripts, CAD payloads, model prompts or credentials', () => {
    const j = journal();
    j.record(event('intent_planned', {
      transcript:'SECRET_TRANSMISSION', text:'SECRET_SPOKEN',
      plan:{ input: { password:'SECRET_PASSWORD' } }, body:{ssn:'SECRET_SSN'},
      authorization:'SECRET_BEARER', apiKey:'SECRET_API_KEY',
      prompt:'SECRET_PROMPT', headers:{cookie:'SECRET_COOKIE'},
      reason:'wake_word', elapsedMs:10, audioBytes:640,
    }));
    const stored = recent(j);
    expect(stored).toHaveLength(1);
    expect(stored[0].details).toEqual({ reason:'wake_word', elapsedMs:10, audioBytes:640 });
    const combined = JSON.stringify(stored) + logs.join(' ');
    expect(combined).not.toMatch(/SECRET_/);
    expect(combined).not.toContain('transcript');
  });
  it('keeps only a bounded number of entries and expires records by age', async () => {
    const j=journal({maxEntries:10,retentionMs:1000,rateLimit:100});
    for(let i=0;i<35;i++) j.record(event('phase-'+i,{stageMs:i}));
    expect(j.entries).toHaveLength(10);
    expect(recent(j)).toHaveLength(10);
    await vi.advanceTimersByTimeAsync(1001);
    expect(recent(j)).toHaveLength(0);
    expect(j.getSummary().retained).toBe(0);
  });
  it('rate-limits a repeated event storm but preserves unrelated diagnostic phases', () => {
    const j=journal({rateLimit:3,maxEntries:10});
    for(let i=0;i<200;i++) j.record(event('audio_decode_failed',{code:'DECODE_ERROR'}));
    j.record(event('intent_failed',{code:'PROVIDER_ERROR'}));
    expect(j.entries).toHaveLength(4);
    expect(j.getSummary().suppressed).toBe(197);
    expect(logs.filter(x=>x.includes('audio_decode_failed'))).toHaveLength(1);
    expect(recent(j).some(x=>x.phase==='intent_failed')).toBe(true);
  });
  it('does not flood the console with repeated terminal callbacks', () => {
    const j=journal({maxEntries:10,rateLimit:2});
    for(let i=0;i<100;i++) j.record(event('turn_completed',{outcome:'processed'}));
    expect(logs.filter(x=>x.includes('turn_completed'))).toHaveLength(1);
    expect(j.entries).toHaveLength(10);
  });
  it('denies anonymous, wrong-scope, cross-center and wrong-runtime diagnostics reads', () => {
    const j=journal();
    j.record(event('intent_planned',{reason:'approved'},'center-a'));
    j.record(event('intent_planned',{reason:'approved'},'center-b'));
    expect(j.getRecent()).toEqual([]);
    expect(recent(j,{...ACCESS,scopes:['unit.read']})).toEqual([]);
    expect(recent(j,{...ACCESS,dispatchCenterId:'center-b'})).toEqual([]);
    expect(recent(j,{...ACCESS,dispatchCenterId:'center-b',runtimeId:'audit-center-b'})).toHaveLength(1);
    expect(recent(j,ACCESS)).toHaveLength(1);
    expect(j.getTrace({turnId:'anything',access:{...ACCESS,scopes:[]}})).toEqual([]);
  });
  it('distinguishes not-addressed, unintelligible, ambiguous, unsupported and denial outcomes', () => {
    const j=journal();
    j.record(event('transmission_ignored',{reason:'not_addressed'}));
    j.record(event('ptt_empty'));
    j.record(event('action_failed',{code:'UNIT_AMBIGUOUS'}));
    j.record(event('action_failed',{code:'INVALID_ACTION'}));
    j.record(event('action_failed',{code:'UNAUTHORIZED'}));
    j.record(event('intent_failed',{code:'CAD_UNAVAILABLE'}));
    j.record(event('outbound_failed',{reason:'floor_or_transmission_failed'}));
    expect(recent(j).map(x=>x.classification)).toEqual([
      'not_addressed','unintelligible_audio','ambiguity','unsupported_capability',
      'denied_action','provider_failure','delivery_failure',
    ]);
  });
  it('does not allow raw diagnostic objects to escape via the operator read', () => {
    const j=journal();
    j.record(event('action_completed',{verified:true,code:null}));
    const row=recent(j)[0];
    expect(row).toMatchObject({details:{verified:true}});
    expect(row).not.toHaveProperty('turnEnvelope');
    expect(row).not.toHaveProperty('turnIdentity');
    expect(row).not.toHaveProperty('accountId');
    expect(row).not.toHaveProperty('connectionId');
  });
  it('records verified CAD action and stage duration on the actual radio runtime path', async () => {
    const h=await make();
    await h.send('Central, available','A1');
    const envelope=h.transcribe.mock.calls[0][1].turnEnvelope;
    const trace=h.diagnostics.getTrace({turnId:envelope.turnId,access:ACCESS});
    expect(trace.some(x=>x.phase==='turn_intake_accepted')).toBe(true);
    expect(trace.some(x=>x.phase==='turn_addressed')).toBe(true);
    expect(trace.some(x=>x.phase==='conversation_selected')).toBe(true);
    expect(trace.some(x=>x.phase==='cad_request_started')).toBe(true);
    expect(trace.some(x=>x.phase==='cad_request_completed' && x.latencyMs >= 0)).toBe(true);
    expect(trace.some(x=>x.phase==='cad_verification_outcome' && x.details.verified === true)).toBe(true);
    expect(trace.some(x=>x.phase==='outbound_completed' && x.classification==='delivered_to_relay')).toBe(true);
    expect(trace.some(x=>x.phase==='turn_completed')).toBe(true);
    expect(h.diagnostics.getSummary({runtimeId:h.context.runtimeId}).activeTurns).toBe(0);
  });
  it('leaves the status endpoint with aggregate counts, not an unrestricted diagnostic transcript', async () => {
    const h=await make();
    await h.send('Central, available');
    const status=h.runtime.getPipelineStatus();
    expect(status.recentDiagnostics).toEqual([]);
    expect(status.diagnosticSummary.retained).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain('Central, available');
    expect(JSON.stringify(status)).not.toContain('synthetic-credential');
  });
  it('keeps per-turn terminal custody when an active capture expires', async () => {
    const h=await make();
    const cap=await h.capture('A1');h.frame(cap);
    await vi.advanceTimersByTimeAsync(90001);
    const accepted=h.diagnostics.record.mock.calls.map(([x])=>x).find(x=>x.phase==='turn_intake_accepted');
    const terminal=h.diagnostics.getTrace({turnId:accepted.turnIdentity.turnId,access:ACCESS});
    // An expired capture is a distinct terminal path, not a silent catch-all.
    expect(terminal.some(x=>x.phase==='turn_scheduler_terminal' && x.details.reason==='capture_expired')).toBe(true);
  });
  it('records a durable timeout/cancellation reason without exporting the provider response', () => {
    const j=journal();
    j.record(event('turn_scheduler_terminal',{reason:'queue_expired',queueAgeMs:30001,
      payload:{private:'value'},transcript:'sensitive'}));
    expect(recent(j)[0]).toMatchObject({details:{reason:'queue_expired',queueAgeMs:30001}});
    expect(recent(j)[0].classification).toBe('expired_or_canceled');
  });
  it('does not invent a model cost when only token counts are available', () => {
    const j=journal();
    j.record(event('model_usage',{promptTokens:100,completionTokens:20,totalTokens:120}));
    expect(recent(j)[0].details).toEqual({promptTokens:100,completionTokens:20,totalTokens:120});
    expect(recent(j)[0].details).not.toHaveProperty('estimatedCostUsd');
  });
  it('filters a correlation without sharing events from another runtime', () => {
    const j=journal();
    j.record(event('intent_planned',{reason:'a'},'center-a'));
    j.record(event('intent_planned',{reason:'b'},'center-b'));
    j.record({...event('intent_failed',{code:'CAD_UNAVAILABLE'}),correlationId:'other'});
    expect(recent(j,ACCESS,{correlationId:'turn-synthetic'})).toHaveLength(1);
    expect(recent(j,ACCESS,{correlationId:'other'})).toHaveLength(1);
  });
});
