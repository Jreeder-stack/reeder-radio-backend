import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  profiles: [], accounts: new Map(), sessions: new Map(), grants: new Map(),
  callbacks: { start: [], end: [], emergencyStart: [], emergencyEnd: [] },
  listeners: new Map(), sttReplies: new Map(), spoken: [], requests: [], statuses: new Map(),
  stallBody: null, synthWait: null, fetchCount: 0,
}));

const query = vi.hoisted(() => vi.fn(async (sql, args = []) => {
  const text = String(sql).replace(/\s+/g, ' ');
  const key = String(args[0]);
  if (text.includes('FROM session WHERE sid = $1')) {
    return { rows: state.sessions.has(key) ? [{ sess: { user: { id: state.sessions.get(key) } } }] : [] };
  }
  if (text.includes("FROM users WHERE id = $1")) {
    const u = state.accounts.get(key);
    return { rows: u?.status === 'active' ? [u] : [] };
  }
  if (text.includes('FROM user_channel_access uca')) return { rows: state.grants.get(key) || [] };
  if (text.includes('SELECT * FROM ai_dispatcher_profiles WHERE')) return {
    rows: state.profiles.filter(p => p.id === args[0]),
  };
  if (text.includes('SELECT * FROM ai_dispatcher_profiles ORDER')) return { rows: state.profiles };
  if (text.includes('UPDATE ai_dispatcher_profiles SET')) return { rows: [] };
  throw new Error('Unexpected synthetic query ' + text);
}));
vi.mock('../../db/index.js', () => ({
  default: { query }, getRadioByToken: vi.fn(async () => null),
  getAiDispatchChannel: vi.fn(), getAllChannels: vi.fn(async () => []),
  isAiDispatchEnabled: vi.fn(), getStatusChecksEnabledState: vi.fn(),
}));
vi.mock('../signalingService.js', () => {
  const on = kind => fn => {
    state.callbacks[kind].push(fn);
    return () => { state.callbacks[kind] = state.callbacks[kind].filter(cb => cb !== fn); };
  };
  return { signalingService: {
    onPttStart: on('start'), onPttEnd: on('end'),
    onEmergencyStart: on('emergencyStart'), onEmergencyEnd: on('emergencyEnd'),
    io: {}, emergencyStates: new Map(), unitPresence: new Map(),
  } };
});
vi.mock('../audioRelayService.js', () => ({ audioRelayService: {
  addAudioListener: vi.fn((channel, identity, listener) => state.listeners.set(String(channel), listener)),
  removeAllAudioListeners: vi.fn(() => state.listeners.clear()),
  hasRecentInbound: vi.fn(() => false), injectAudio: vi.fn(),
} }));
vi.mock('../opusCodec.js', () => ({ opusCodec: {
  decodeOpusToPcm: vi.fn(() => Buffer.alloc(640)),
  releaseSenderDecoder: vi.fn(),
  encodePcmToOpus: vi.fn(() => [Buffer.from([1])]),
} }));
vi.mock('../floorControlService.js', () => ({ floorControlService: {
  requestFloor: vi.fn(() => ({ granted: true })),
  releaseFloor: vi.fn(() => true), releaseAllForUnit: vi.fn(),
}, AI_FLOOR_IDENTITY:'AI-Dispatcher' }));
vi.mock('../emergencyPagingService.js', () => ({
  pageEmergencyUnits: vi.fn(() => { throw Error('Live emergency page prohibited'); }),
}));
vi.mock('../azureSpeechService.js', () => ({
  isConfigured: () => true,
  speechToText: vi.fn(async (_audio, options) => {
    const id = options.turnEnvelope.speakerRef;
    const queue = state.sttReplies.get(id) || [];
    if (!queue.length) throw new Error('No synthetic STT for '+id);
    return await queue.shift();
  }),
  textToSpeech: vi.fn(async text => {
    state.spoken.push(text);
    if (state.synthWait) return state.synthWait;
    return Buffer.alloc(640);
  }),
}));
vi.mock('../cadService.js', () => ({
  CORE_AI_DISPATCHER_CAD_SCOPES: ['unit.read','unit.write','call.read','call.write'],
  validateDispatcherCadIntegration: vi.fn(async () => ({
    success:true, scopes:['unit.read','unit.write','call.read','call.write'],
  })),
}));
vi.mock('openai', () => ({
  AzureOpenAI: class { constructor() { throw Error('Real model provider prohibited'); } },
}));
import { AIDispatcherRuntimeManager } from '../aiDispatcherRuntimeManager.js';
import { createPttTransmission, finishPttTransmission, loadSessionPttPrincipal } from '../pttProvenance.js';
import { observe, until, finish, START_TIME } from '../../dispatcher-v3/__tests__/helpers/auditRuntimeHarness.js';
import { audioRelayService } from '../audioRelayService.js';

function profile(key, channel) {
  return { id:'profile-'+key, name:'Center '+key, enabled:true, channel_id:channel, channel_name:'OPS1',
    room_key:key+'__OPS1', dispatch_center_id:'center-'+key, identity:'AI-DISPATCHER:'+key,
    status_checks_enabled:false };
}
function json(value) { return { ok:true,status:200,headers:new Headers(),text:async()=>JSON.stringify(value) }; }
function fakeCad(urlString, options) {
  const url=new URL(urlString), center=url.searchParams.get('dispatch_center_id');
  const method=options.method || 'GET';
  const body=options.body ? JSON.parse(options.body) : null;
  if (options.headers.get('X-Dispatch-Center-Id') !== center) throw Error('Cross-center CAD call');
  const p=state.profiles.find(x=>x.dispatch_center_id===center);
  if (!p || options.headers.get('X-Dispatcher-Runtime-Id')!==p.id) throw Error('CAD runtime mismatch');
  state.requests.push({ method, center, path:url.pathname,body, at:Date.now() });
  const status=unit => state.statuses.get(center+':'+unit) || 'on_duty';
  if (url.pathname==='/api/radio/unit/resolve-v3') {
    const unit=url.searchParams.get('unit_ref');
    const id=String(unit).replace(center+'-','');
    if (!['A1','B2'].includes(id)) return { ...json({error:'UNIT_NOT_FOUND'}),ok:false,status:404 };
    return json({success:true,unit:{id:center+'-'+id,unit_number:id,unit_id:id,status:status(id),agency_id:'synthetic'}});
  }
  if (url.pathname==='/api/radio/status-check') return json({success:true,
    units:['A1','B2'].map(id=>({unit_id:id,status:status(id)}))});
  if (url.pathname==='/api/radio/calls') return json({success:true,calls:[]});
  if (url.pathname.endsWith('/call')) return json({success:true,call:null});
  if (method==='POST' && url.pathname==='/api/radio/status') {
    state.statuses.set(center+':'+body.unit_id,body.status);
    if (state.stallBody) return { ...json({success:true}),text:()=>state.stallBody };
    return json({success:true});
  }
  throw Error('Unexpected CAD operation '+method+' '+url.pathname);
}
let manager;
function supply(unit, text) {
  const queue=state.sttReplies.get(unit) || [];
  queue.push(text);state.sttReplies.set(unit,queue);
}
function defer() { let resolve; const promise=new Promise(r=>{ resolve=r; });return {promise,resolve}; }
async function start(profiles) {
  state.profiles=profiles;
  manager=new AIDispatcherRuntimeManager();
  manager.ensureSchema=vi.fn(async()=>{});
  for(const p of profiles) await manager.startProfile(p.id);
  return manager;
}
async function ptt(profileRow, accountId, unit, text) {
  state.accounts.set(accountId,{ id:accountId, username:accountId,unit_id:unit,status:'active' });
  state.sessions.set('session-'+accountId,accountId);
  state.grants.set(accountId,[{channel_id:profileRow.channel_id,channel_name:'OPS1',room_key:profileRow.room_key}]);
  if (text!==undefined) supply(unit,text);
  const principal=await loadSessionPttPrincipal('session-'+accountId,{connectionId:'socket-'+accountId});
  const source=createPttTransmission(principal,{channelId:profileRow.room_key,captureStartedAt:Date.now()});
  return { row:profileRow, unit, source };
}
async function emit(kind, data, source) {
  return Promise.all(state.callbacks[kind].map(fn=>fn(data,source)));
}
async function send(capture) {
  const data={channelId:capture.row.room_key,unitId:capture.unit};
  const accepted=await emit('start',data,capture.source);
  if (!accepted.includes(true)) return {accepted:false};
  const frame=state.listeners.get(capture.row.room_key);
  if (!frame) throw Error('Missing actual runtime audio listener');
  frame({unitId:capture.unit,opusPayload:Buffer.from([8]),codec:'opus'});
  const end=finishPttTransmission(capture.source,Date.now());
  const result=observe(emit('end',data,end));
  return {accepted:true,result};
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(START_TIME);
  vi.stubEnv('AZURE_OPENAI_DEPLOYMENT','synthetic-local-only');
  vi.stubEnv('AZURE_OPENAI_API_KEY','synthetic-do-not-call');
  vi.stubEnv('AZURE_OPENAI_ENDPOINT','https://invalid.example.test');
  vi.stubEnv('CAD_URL','https://cad.example.test');
  vi.stubEnv('CAD_API_KEY','synthetic-no-real-network');
  state.profiles=[];state.accounts.clear();state.sessions.clear();state.grants.clear();
  state.listeners.clear();state.sttReplies.clear();state.spoken=[];state.requests=[];state.statuses.clear();
  state.stallBody=null;state.synthWait=null;state.fetchCount=0;
  for (const key of Object.keys(state.callbacks)) state.callbacks[key]=[];
  vi.stubGlobal('fetch',vi.fn(fakeCad));
  vi.spyOn(console,'log').mockImplementation(()=>{});
  manager=null;
});
afterEach(async()=>{
  try {
    if(manager) await manager.shutdown();
    await vi.advanceTimersByTimeAsync(50);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();
  }
});
describe('01-08 live manager + actual V3 runtime integration with synthetic CAD',()=>{
  it('routes real trusted PTT into ordered same-unit CAD writes and independent B2',async()=>{
    const [a]=[profile('a',41)];await start([a]);
    const delayed=defer();const one=await ptt(a,'u-a','A1',delayed.promise);
    const first=await send(one);
    await until(()=>state.sttReplies.get('A1').length===0,'first transcription started');
    const two=await ptt(a,'u-a','A1','Central, available');
    const second=await send(two);
    const b=await ptt(a,'u-b','B2','Central, available');
    const independent=await send(b);
    await until(()=>state.requests.some(x=>x.method==='POST'&&x.body.unit_id==='B2'),'independent B2');
    expect(state.requests.filter(x=>x.method==='POST').map(x=>x.body.unit_id)).toEqual(['B2']);
    delayed.resolve('Central, en route');
    await until(()=>[first,second,independent].every(x=>x.result.settled),'routed turns',2000);
    expect(state.requests.filter(x=>x.method==='POST').map(x=>[x.body.unit_id,x.body.status]))
      .toEqual([['B2','available'],['A1','en_route'],['A1','available']]);
    expect(manager.runtimes.get(a.id).dispatcher.getPipelineStatus().scheduler.resident).toBe(0);
    expect(state.statuses.get('center-a:A1')).toBe('available');
  });
  it('keeps same callsign in different centers separated by manager routing',async()=>{
    const a=profile('a',41),b=profile('b',42);await start([a,b]);
    const packet=await ptt(b,'u-b','A1','Central, available');
    const invalid=await emit('start',{channelId:a.room_key,unitId:'A1'},packet.source);
    expect(invalid.every(v=>v===false)).toBe(true);
    const valid=await send(packet);expect(valid.accepted).toBe(true);
    await until(()=>valid.result.settled,'B center');
    expect(state.requests.filter(x=>x.method==='POST').map(x=>x.center)).toEqual(['center-b']);
    expect(state.statuses.has('center-a:A1')).toBe(false);
    expect(state.statuses.get('center-b:A1')).toBe('available');
    expect(manager.runtimes.get(a.id).dispatcher.getPipelineStatus().intakeSequence).toBe(0);
  });
  it('stop and restart invalidate old transcription and unregister duplicate listeners',async()=>{
    const a=profile('a',41);await start([a]);
    const deferred=defer();const old=await ptt(a,'u-a','A1',deferred.promise);
    const first=await send(old);
    await until(()=>state.sttReplies.get('A1').length===0,'old transcription');
    const oldGeneration=manager.runtimes.get(a.id).dispatcher.runtimeGeneration;
    await manager.restartProfile(a.id);
    expect(manager.runtimes.get(a.id).dispatcher.runtimeGeneration).not.toBe(oldGeneration);
    expect(state.callbacks.start).toHaveLength(1);
    expect(state.callbacks.end).toHaveLength(1);
    deferred.resolve('Central, available');
    await until(()=>first.result.settled,'old turn shutdown');
    expect(state.requests.filter(x=>x.method==='POST')).toHaveLength(0);
    const next=await send(await ptt(a,'u-a','A1','Central, en route'));
    await until(()=>next.result.settled,'new turn');
    expect(state.statuses.get('center-a:A1')).toBe('en_route');
  });
  it('enforces real-runtime queue backpressure at the manager callback',async()=>{
    const a=profile('a',41);await start([a]);
    const firstWords=defer();const pending=[];
    for(let i=0;i<8;i++){
      const cap=await ptt(a,'u-a','A1',i===0?firstWords.promise:'Central, available');
      pending.push(await send(cap));
    }
    const ninth=await send(await ptt(a,'u-a','A1','Central, available'));
    expect(ninth.accepted).toBe(false);
    expect(manager.runtimes.get(a.id).dispatcher.getPipelineStatus().scheduler.resident).toBe(8);
    firstWords.resolve('Central, en route');
    await until(()=>pending.every(p=>p.result.settled),'queue drain',2500);
    expect(state.requests.filter(x=>x.method==='POST')).toHaveLength(8);
  });
  it('times out CAD response body without duplicate mutation through manager path',async()=>{
    const a=profile('a',41);await start([a]);
    const stalled=defer();state.stallBody=stalled.promise;
    const sent=await send(await ptt(a,'u-a','A1','Central, available'));
    await until(()=>state.requests.some(x=>x.method==='POST'),'CAD request entered');
    await vi.advanceTimersByTimeAsync(8050);
    await until(()=>sent.result.settled,'bounded CAD outcome');
    expect(state.requests.filter(x=>x.method==='POST')).toHaveLength(1);
    stalled.resolve(JSON.stringify({success:true}));await vi.advanceTimersByTimeAsync(1);
    expect(state.requests.filter(x=>x.method==='POST')).toHaveLength(1);
    expect(state.spoken.join(' ')).not.toContain('confirmed available');
  });
});
