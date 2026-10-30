
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/audioRelayService.js', () => ({ audioRelayService: {} }));
vi.mock('../../services/signalingService.js', () => ({ signalingService: {} }));
vi.mock('../../services/azureSpeechService.js', () => ({
  speechToText: () => { throw Error('External STT forbidden'); },
  textToSpeech: () => { throw Error('External TTS forbidden'); },
}));
vi.mock('../../services/opusCodec.js', () => ({ opusCodec: {} }));
vi.mock('../../services/floorControlService.js', () => ({ floorControlService: {}, AI_FLOOR_IDENTITY: 'AI-Dispatcher' }));
vi.mock('../../services/emergencyPagingService.js', () => ({ pageEmergencyUnits: () => { throw Error('Live paging forbidden'); } }));
vi.mock('openai', () => ({ AzureOpenAI: class { constructor() { throw Error('Paid model forbidden'); } } }));
import { START_TIME, NO_ACTION, createHarness, finish, observe, until, plan } from './helpers/auditRuntimeHarness.js';

const UNITS = ['A1', 'B2', 'C3', 'D4', 'E5'];
const answer = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const question = () => ({ action: 'CLARIFY', input: {}, confidence: 1, clarification: 'Which call?' });
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
function dynamic(h, decide) {
  h.llm.mockImplementation(async request => {
    const input = JSON.parse(request.messages[1].content);
    return answer(decide(input) || NO_ACTION);
  });
}
function assignments(h) { return h.writes('/api/radio/assign').map(record => record.body); }
function linkedSocket(h, principal, socketId) {
  const channel = h.context.roomKey;
  const socket = {
    connected: true, pttPrincipal: principal, unitId: principal.unitId,
    channels: new Set([channel]), rooms: new Set(['channel:' + channel]),
  };
  h.runtime.signaling.io.sockets ||= { sockets: new Map() };
  h.runtime.signaling.io.sockets.sockets.set(socketId, socket);
  return socket;
}
async function speak(h, principal, text, unit = 'A1') {
  const capture = await h.capture(unit, { principal });
  expect(capture.accepted).toBe(true);
  h.frame(capture);
  const result = await finish(h.end(capture, text));
  await h.flushOutput();
  return result;
}
const originalTaskPlanner = (input) => /put me on that call/i.test(input.transcript)
  ? plan('ASSIGN_UNIT', { unitRef: input.speakerCallsign, callRef: 'that call' })
  : ['OLD-CALL', 'NEW-CALL'].includes(input.transcript)
    ? plan('ASSIGN_UNIT', { callId: input.transcript }) : NO_ACTION;

describe('AI-DISP-V3-001 02-08 actual five-unit PTT/CAD conversation integration', () => {
  it('all five units interleave authenticated status changes with independent conversation IDs', async () => {
    const h = await make();
    for (const unit of ['C3', 'A1', 'E5', 'B2', 'D4']) {
      expect(await h.send('Central, available', unit)).toBe(true);
    }
    expect(h.writes('/api/radio/status').map(record => record.body.unit_id))
      .toEqual(['C3','A1','E5','B2','D4']);
    const records = [...h.runtime.conversations.conversations.values()];
    expect(records).toHaveLength(5);
    expect(new Set(records.map(item => item.id)).size).toBe(5);
    expect(new Set(records.map(item => item.speakerUnitId)).size).toBe(5);
    for (const record of records) {
      expect(record.turns).toHaveLength(1);
      expect(record.turns[0].speakerRef).toBe(record.speakerRef);
    }
    expect(h.runtime.conversationGate.pending.size).toBe(0);
  });

  it('A1 delayed transcription cannot block B2, C3, D4, E5 or reorder its later command', async () => {
    const h = await make(), delayed = h.hold('Central, en route');
    const first = await h.begin(delayed.promise, 'A1');
    await until(() => h.transcribe.mock.calls.length > 0, 'A1 transcription');
    for (const unit of ['B2','C3','D4','E5']) await h.send('Central, available', unit);
    const second = await h.begin('Central, available', 'A1');
    expect(h.writes('/api/radio/status').map(record => record.body.unit_id))
      .toEqual(['B2','C3','D4','E5']);
    delayed.resolve('Central, en route');
    await finish(first); await finish(second); await h.flushOutput();
    expect(h.writes('/api/radio/status').slice(-2).map(record => [record.body.unit_id, record.body.status]))
      .toEqual([['A1','en_route'],['A1','available']]);
    expect(h.runtime._scheduler.status().resident).toBe(0);
  });

  it('five independently delivered call clarifications resolve only their original units', async () => {
    const h = await make();
    dynamic(h, originalTaskPlanner);
    for (const unit of UNITS) await h.send('Central, put me on that call', unit);
    expect(h.runtime.conversationGate.pending.size).toBe(5);
    expect(assignments(h)).toEqual([]);
    for (const unit of ['E5','C3','A1','D4','B2']) {
      expect(h.runtime.conversationGate.pendingFor(unit)?.promptState).toBe('delivered');
      const target = ['E5','A1','B2'].includes(unit) ? 'OLD-CALL' : 'NEW-CALL';
      await h.send(target, unit);
    }
    expect(assignments(h)).toHaveLength(5);
    expect(new Set(assignments(h).map(item => item.unit_id))).toEqual(new Set(UNITS));
    for (const item of assignments(h)) expect(h.cad.current.get(item.unit_id)).toBe(item.call_id);
  });

  it('A1 cancels its request without corrupting four other pending unit answers', async () => {
    const h = await make();
    dynamic(h, originalTaskPlanner);
    for (const unit of UNITS) await h.send('Central, put me on that call', unit);
    const prior = h.runtime.conversationGate.pendingFor('A1');
    await h.send('Central, never mind', 'A1');
    expect(h.runtime.conversationGate.pendingFor('A1')).toBeUndefined();
    for (const unit of ['B2','C3','D4','E5']) await h.send('OLD-CALL', unit);
    expect(assignments(h).map(item => item.unit_id)).toEqual(['B2','C3','D4','E5']);
    expect(h.runtime.conversationGate.isCurrentPending('A1', prior)).toBe(false);
  });

  it('A1 resumes its own suspended assignment after changing topics and four intervening units', async () => {
    const h = await make();
    dynamic(h, originalTaskPlanner);
    await h.send('Central, put me on that call', 'A1');
    const previous = h.runtime.conversationGate.pendingFor('A1');
    await h.send('Central, new topic: radio check', 'A1');
    expect([...h.runtime.conversations.conversations.values()].find(r => r.speakerRef === 'A1')
      .suspendedTasks.some(t => t.id === previous.taskId)).toBe(true);
    for (const unit of ['B2','C3','D4','E5']) await h.send('Central, available', unit);
    await h.send('Central, resume my earlier assignment', 'A1');
    const resumed = h.runtime.conversationGate.pendingFor('A1');
    expect(resumed?.taskId).toBe(previous.taskId);
    expect(resumed?.promptTurnId).not.toBe(previous.promptTurnId);
    await h.send('OLD-CALL', 'A1');
    expect(assignments(h)).toMatchObject([{ unit_id:'A1', call_id:'OLD-CALL' }]);
    expect(h.writes('/api/radio/note')).toEqual([]);
  });

  it('A1 and B2 share fresh incident facts, not A1 private dialogue or raw note instructions', async () => {
    const h = await make();
    h.cad.current.set('A1','OLD-CALL'); h.cad.current.set('B2','OLD-CALL');
    h.cad.calls.get('OLD-CALL').assigned_units = [{unit_id:'A1'},{unit_id:'B2'}];
    dynamic(h, ({ transcript }) => {
      if (/add a note/i.test(transcript)) return plan('ADD_CALL_NOTE',{callId:'OLD-CALL',note:'Subject walking north'});
      if (/our call/i.test(transcript)) return plan('GET_CALL',{callId:'OLD-CALL'});
      return NO_ACTION;
    });
    await h.send('Central, add a note: subject walking north','A1');
    for(const unit of ['C3','D4','E5']) await h.send('Central, available',unit);
    await h.send('Central, what is the update on our call?','B2');
    const planned = h.runtime.planner.plan.mock.calls.at(-1)[0];
    expect(planned.sharedIncident).toMatchObject({callId:'OLD-CALL',participatingUnits:['A1','B2']});
    expect(planned.pendingContext).toBeNull();
    expect(planned.recentContext).toEqual([]);
    expect(h.spoken().at(-1)).toMatch(/A1 reported: Subject walking north.*unverified report/i);
    expect(h.writes('/api/radio/note')).toHaveLength(1);
    await h.send('Central, what is our call?','C3');
    const other = h.runtime.planner.plan.mock.calls.at(-1)[0];
    expect(other.sharedIncident).toBeNull();
  });

  it('ambiguous group instructions cannot mutate other units despite five-unit radio traffic', async () => {
    const h = await make();
    dynamic(h, ({ transcript }) => /both of us/i.test(transcript)
      ? plan('SET_UNIT_STATUS',{unitRef:'A1',status:'available'}) : NO_ACTION);
    await h.send('Central, mark both of us available','A1');
    expect(h.writes('/api/radio/status')).toEqual([]);
    for(const unit of ['B2','C3','D4','E5']) await h.send('Central, available',unit);
    expect(h.writes('/api/radio/status').map(x=>x.body.unit_id)).toEqual(['B2','C3','D4','E5']);
    expect(h.cad.units[0].status).toBe('on_duty');
  });

  it('two concurrently connected same-account devices hold separate same-callsign prompt receipts', async () => {
    const h = await make();
    dynamic(h, ({ transcript }) => /which call/i.test(transcript) ? question() : NO_ACTION);
    const one = await h.principal('A1',{connectionId:'socket:one'});
    const two = await h.principal('A1',{accountId:one.accountId,connectionId:'socket:two'});
    linkedSocket(h,one,'one'); linkedSocket(h,two,'two');
    await speak(h,one,'Central, which call was that?');
    await speak(h,two,'Central, which call was that?');
    const records = [...h.runtime.conversations.conversations.values()];
    expect(records).toHaveLength(2);
    const first = records.find(r=>r.connectionId==='socket:one');
    const second = records.find(r=>r.connectionId==='socket:two');
    const a = h.runtime.conversationGate.pendingFor('A1',first.scopeKey);
    const b = h.runtime.conversationGate.pendingFor('A1',second.scopeKey);
    expect(a?.promptState).toBe('delivered'); expect(b?.promptState).toBe('delivered');
    expect(h.runtime.conversationGate.pendingFor('A1')).toBeUndefined();
    for (const receipt of [a,b]) {
      expect(receipt).not.toHaveProperty('pendingTask');
      expect(receipt).not.toHaveProperty('callId');
      expect(receipt).not.toHaveProperty('clarification');
    }
    await speak(h,one,'first response');
    expect(h.runtime.conversationGate.pendingFor('A1',second.scopeKey)).toBe(b);
    await speak(h,two,'second response');
    expect(h.writes()).toEqual([]);
  });

  it('D4 changing channel mid-model prevents its CAD write while other four units finish', async () => {
    const h = await make();
    const principal = await h.principal('D4',{connectionId:'socket:d4'});
    const socket = linkedSocket(h,principal,'d4');
    const held = h.hold(answer(plan('SET_UNIT_STATUS',{unitRef:'D4',status:'available'})));
    h.llm.mockImplementationOnce(()=>held.promise);
    const capture = await h.capture('D4',{principal}); h.frame(capture);
    const pending = h.end(capture,'Central, update my status to available');
    await until(()=>h.llm.mock.calls.length===1,'D4 model');
    socket.channels.clear(); socket.rooms.clear();
    for(const unit of ['A1','B2','C3','E5']) await h.send('Central, available',unit);
    held.resolve(answer(plan('SET_UNIT_STATUS',{unitRef:'D4',status:'available'})));
    await finish(pending); await h.flushOutput();
    expect(h.writes('/api/radio/status').map(item=>item.body.unit_id)).toEqual(['A1','B2','C3','E5']);
    expect(h.cad.units.find(item=>item.unit_number==='D4').status).toBe('on_duty');
  });

  it('identical A1 callsigns from different centers cannot acquire one another conversation or CAD writes', async () => {
    const a = await make({center:'center-a'}), b = await make({center:'center-b'});
    await a.send('Central, available','A1');
    await b.send('Central, en route','A1');
    for(const unit of ['B2','C3','D4','E5']) await a.send('Central, available',unit);
    expect(a.writes('/api/radio/status').every(item=>item.center==='center-a')).toBe(true);
    expect(b.writes('/api/radio/status').every(item=>item.center==='center-b')).toBe(true);
    expect(a.cad.units[0].status).toBe('available');
    expect(b.cad.units[0].status).toBe('en_route');
    expect(a.runtime.conversations.conversations.size).toBe(5);
    expect(b.runtime.conversations.conversations.size).toBe(1);
  });

  it('stale answers expire without reviving an old task or changing durable CAD records', async () => {
    const h = await make();
    dynamic(h, ({transcript})=>/which call/i.test(transcript)?question():NO_ACTION);
    await h.send('Central, which call?','A1');
    expect(h.runtime.conversationGate.pendingFor('A1')?.promptState).toBe('delivered');
    await vi.advanceTimersByTimeAsync(31000);
    expect(await h.send('OLD-CALL','A1')).toBe(false);
    expect(h.runtime.conversationGate.pendingFor('A1')).toBeUndefined();
    for(const unit of ['B2','C3','D4','E5']) await h.send('Central, available',unit);
    expect(h.writes('/api/radio/status')).toHaveLength(4);
  });

  it('hardware emergency A1 cannot be cleared by B2 or consume C3 pending answer', async () => {
    const h = await make();
    dynamic(h,originalTaskPlanner);
    h.runtime.signaling.endEmergencyForUnit=vi.fn();
    h.runtime.signaling._emitToChannelDispatchers=vi.fn();
    await h.send('Central, put me on that call','C3');
    const waiting=h.runtime.conversationGate.pendingFor('C3');
    expect(waiting?.promptState).toBe('delivered');
    expect(await finish(observe(h.runtime.handleEmergencyStart(h.context.roomKey,'A1')))).toBe(true);
    expect(h.runtime.getPipelineStatus().emergency?.source).toBe('hardware');
    await h.send('Central, A1, I am okay','B2');
    expect(h.runtime.getPipelineStatus().emergency?.unitId).toBe('A1');
    expect(h.runtime.conversationGate.pendingFor('C3')).toBe(waiting);
    await h.send('OLD-CALL','C3');
    expect(assignments(h)).toMatchObject([{unit_id:'C3',call_id:'OLD-CALL'}]);
    await h.send('10-4','A1');
    expect(h.runtime.getPipelineStatus().emergency).toBeNull();
    expect(h.runtime.signaling.endEmergencyForUnit)
      .toHaveBeenCalledExactlyOnceWith('A1','status_check_safe_response');
  });

  it('stop/restart retires five pending leases and rejects stale answers', async () => {
    const h = await make();
    dynamic(h, ({transcript})=>/which call/i.test(transcript)?question():NO_ACTION);
    for(const unit of UNITS) await h.send('Central, which call?',unit);
    expect(h.runtime.conversationGate.pending.size).toBe(5);
    await h.runtime.stop(); await h.runtime.start();
    expect(h.runtime.conversationGate.pending.size).toBe(0);
    expect(h.runtime.conversations.conversations.size).toBe(0);
    for(const unit of UNITS) expect(await h.send('OLD-CALL',unit)).toBe(false);
    for(const unit of UNITS) await h.send('Central, available',unit);
    expect(h.writes('/api/radio/status')).toHaveLength(5);
  });
});
