import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw Error('Live STT prohibited'); },
  textToSpeech: () => { throw Error('Live TTS prohibited'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({
  floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher',
}));
vi.mock('../../services/emergencyPagingService.js', () => ({
  pageEmergencyUnits: () => { throw Error('Live paging prohibited'); },
}));
vi.mock('openai', () => ({ AzureOpenAI: class {
  constructor() { throw Error('Paid model prohibited'); }
} }));

import { normalizeV3SemanticPlan } from '../semanticContract.js';
import { START_TIME, createHarness } from './helpers/auditRuntimeHarness.js';

const compound = actions => ({ intentType: 'action_request', actions, confidence: 1 });
const create = (id = 'create') => ({
  id, action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main Street' },
});
const status = (id = 'status', statusValue = 'on_scene', extra = {}) => ({
  id, action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: statusValue }, ...extra,
});
let opened, network;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START_TIME);
  vi.stubEnv('AI_DISPATCHER_WAKE_WORDS', 'central,dispatch,dispatcher');
  network = vi.fn(() => { throw Error('External network prohibited in 03-03'); });
  vi.stubGlobal('fetch', network);
  opened = [];
});
afterEach(async () => {
  try {
    for (const h of opened) await h.close();
    expect(network).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
async function make(llmPlans, opts = {}) {
  const h = await createHarness({ llmPlans, ...opts });
  opened.push(h);
  vi.spyOn(h.runtime, '_executeMultiActionPlan');
  return h;
}
async function outcome(h) {
  const call = h.runtime._executeMultiActionPlan.mock.results.at(-1);
  expect(call?.type).toBe('return');
  return await call.value;
}

describe('AI-DISP-V3-001 03-03 compound CAD dependency execution', () => {
  it('normalizes stable step IDs and implicit ordered prerequisites without changing prior semantic output', () => {
    const plan = normalizeV3SemanticPlan(compound([
      { action: 'CREATE_CALL', input: { type: 'BUILDING CHECK', location: '100 Main Street' } },
      { action: 'SET_UNIT_STATUS', input: { unitRef: 'A1', status: 'on_scene' } },
    ]));
    expect(plan.actions).toMatchObject([
      { id: 'step1', dependsOn: [], action: 'CREATE_CALL' },
      { id: 'step2', dependsOn: ['step1'], action: 'SET_UNIT_STATUS' },
    ]);
    expect(plan.actions[0].input.location).toBe('100 Main Street');
  });

  it('rejects forward, unknown and repeated dependencies before a CAD write', () => {
    for (const action of [
      { ...status('status'), dependsOn: ['missing'] },
      { ...status('status'), dependsOn: ['status'] },
      { ...status('status'), dependsOn: [7] },
      { ...status('status'), dependsOn: ['create', 'create'] },
    ]) {
      expect(() => normalizeV3SemanticPlan(compound([create(), action]))).toThrow();
    }
    expect(() => normalizeV3SemanticPlan(compound([create(), create()])))
      .toThrow(/duplicate/i);
  });

  it('rejects fake result payloads, unsupported bindings, and conflicting call references', () => {
    expect(() => normalizeV3SemanticPlan(compound([{
      ...create(), result: { verified: true },
    }]))).toThrow(/step/i);
    expect(() => normalizeV3SemanticPlan(compound([create(), {
      ...status(), callIdFrom: 'create', dependsOn: ['create'],
    }]))).toThrow(/call binding/i);
    expect(() => normalizeV3SemanticPlan(compound([create(), {
      id: 'assign', action: 'ASSIGN_UNIT', callIdFrom: 'create',
      dependsOn: ['create'], input: { unitRef: 'A1', callRef: 'other call' },
    }]))).toThrow(/call binding/i);
  });

  it('preserves a building-check location and both original operations through real mocked PTT and CAD', async () => {
    const h = await make([compound([create(), status()])]);
    expect(await h.send('Central, start a building check at 100 Main Street and mark me on scene')).toBe(true);
    expect(h.writes().map(write => write.path)).toEqual(['/api/radio/v3/cad/calls', '/api/radio/status']);
    expect(h.writes()[0].body.location).toBe('100 Main Street');
    expect(h.cad.units[0].status).toBe('on_scene');
    const result = await outcome(h);
    expect(result.data.steps.map(step => step.status)).toEqual(['verified', 'verified']);
    expect(result.success).toBe(true);
    expect(h.spoken().at(-1)).toMatch(/building check.*100 Main Street.*on scene/i);
  });

  it('binds an assigned unit ONLY to independently verified new-call output', async () => {
    const h = await make([compound([
      create(), { id: 'assign', action: 'ASSIGN_UNIT', input: { unitRef: 'A1' },
        dependsOn: ['create'], callIdFrom: 'create' },
    ])]);
    await h.send('Central, create a building check at 100 Main Street then attach me to that new call');
    const result = await outcome(h);
    expect(result.data.steps.map(step => step.status)).toEqual(['verified', 'verified']);
    expect(h.writes('/api/radio/assign')[0].body.call_id).toMatch(/^CREATED-/);
    expect(h.cad.current.get('A1')).toMatch(/^CREATED-/);
  });

  it('infers one unambiguous verified create-call ancestor for a dependent assignment', async () => {
    const h = await make([compound([
      create(), { id: 'assign', action: 'ASSIGN_UNIT', input: { unitRef: 'A1' } },
    ])]);
    await h.send('Central, create a building check and assign me to the one just created');
    expect((await outcome(h)).data.steps.map(step => step.status)).toEqual(['verified', 'verified']);
    expect(h.writes('/api/radio/assign')).toHaveLength(1);
  });

  it('does not invoke dependent CAD actions when creation was submitted but read-back is missing', async () => {
    const h = await make([compound([
      create(), { id: 'assign', action: 'ASSIGN_UNIT', input: { unitRef: 'A1' },
        dependsOn: ['create'], callIdFrom: 'create' },
    ])]);
    const realCad = h.cad.fetch;
    h.runtime.gateway.fetchImpl = async (url, opts) => {
      const response = await realCad(url, opts);
      if ((opts.method || 'GET') === 'GET'
        && new URL(url).pathname.startsWith('/api/radio/v3/cad/calls/CREATED-')) {
        return { ...response, text: async () => JSON.stringify({ success: true, call: null }) };
      }
      return response;
    };
    await h.send('Central, open a building check and assign me to the created call');
    const result = await outcome(h);
    expect(result.success).toBe(false);
    expect(result.data.steps.map(step => step.status)).toEqual(['unknown', 'skipped_dependency']);
    expect(result.error.details.possibleUnconfirmedWrite).toBe(true);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(h.spoken().at(-1)).toMatch(/unconfirmed|not verified/i);
  });

  it('keeps an independently requested read when a different write cannot be confirmed', async () => {
    const h = await make([compound([
      status('write'), { id: 'read', action: 'GET_CALL',
        input: { callId: 'OLD-CALL' }, dependsOn: [] },
    ])]);
    h.cad.failStatus = true;
    await h.send('Central, change my status and separately read back the Walmart alarm');
    const result = await outcome(h);
    expect(result.success).toBe(false);
    expect(result.data.steps.map(step => step.status)).toEqual(['unknown', 'read_success']);
    expect(h.spoken().at(-1)).toMatch(/unconfirmed.*Walmart/i);
    expect(h.cad.units[0].status).toBe('on_duty');
  });

  it('reports an independently verified information read together with a status mutation', async () => {
    const h = await make([compound([
      { id: 'read', action: 'GET_CALL', input: { callId: 'OLD-CALL' } },
      status('update', 'available', { dependsOn: [] }),
    ])]);
    await h.send('Central, get the Walmart call details and place me available');
    expect((await outcome(h)).success).toBe(true);
    expect(h.writes('/api/radio/status')).toHaveLength(1);
    expect(h.spoken().at(-1)).toMatch(/Walmart.*available/i);
  });

  it('retains first-step success when later unit materialization fails and never replays it', async () => {
    const h = await make([compound([
      create(), { id: 'assign', action: 'ASSIGN_UNIT', input: { unitRef: 'outside-center' },
        dependsOn: ['create'], callIdFrom: 'create' },
    ])]);
    await h.send('Central, start a building check and also attach the requested unit');
    const result = await outcome(h);
    expect(result.data.steps.map(step => step.status)).toEqual(['verified', 'failed']);
    expect(result.error.details.completedSteps).toEqual(['create']);
    expect(h.writes('/api/radio/v3/cad/calls')).toHaveLength(1);
    expect(h.writes('/api/radio/assign')).toHaveLength(0);
    expect(h.spoken().at(-1)).toMatch(/created.*not completed/i);
    await h.send('Central, radio check');
    expect(h.writes('/api/radio/v3/cad/calls')).toHaveLength(1);
  });

  it('deduplicates consecutive identical verified writes but not genuine later status changes', async () => {
    const h = await make([compound([
      status('first', 'available'), status('repeat', 'available'),
      status('change', 'on_scene'), status('again', 'available'),
    ])]);
    await h.send('Central, set me available, repeated, then on scene and finally available');
    expect((await outcome(h)).data.steps.map(step => step.status))
      .toEqual(['verified', 'duplicate_skipped', 'verified', 'verified']);
    expect(h.writes('/api/radio/status').map(write => write.body.status))
      .toEqual(['available', 'on_scene', 'available']);
  });

  it('preserves existing read-only scopes, speaker custody and center isolation per dependent step', async () => {
    const h = await make([compound([
      { id: 'read', action: 'GET_CALL', input: { callId: 'OLD-CALL' } },
      status('write'),
    ])], { scopes: ['call.read', 'unit.read'] });
    await h.send('Central, read the alarm then put me on scene');
    const result = await outcome(h);
    expect(result.data.steps.map(step => step.status)).toEqual(['read_success', 'failed']);
    expect(result.data.steps[1].error.code).toBe('UNAUTHORIZED');
    expect(h.writes()).toEqual([]);
  });
});
