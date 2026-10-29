const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/radio-client.js'), 'utf8');
const A = 'North__Dispatch';
const B = 'South__Dispatch';
const C = 'West__Tactical';
const tick = () => new Promise(setImmediate);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
const cancelled = result => assert.equal(result.error?.code, 'RADIO_OPERATION_CANCELLED');

function harness(t, options = {}) {
  const sockets = [], webSockets = [], contexts = [], nodes = [], streams = [], scripts = [];
  const timers = new Map();
  let timerId = 0, uuid = 0;
  class Socket {
    constructor() { this.handlers = new Map(); this.sent = []; this.connected = false; sockets.push(this); }
    on(name, fn) { if (!this.handlers.has(name)) this.handlers.set(name, new Set()); this.handlers.get(name).add(fn); }
    off(name, fn) { this.handlers.get(name)?.delete(fn); }
    emit(name, data) { this.sent.push({ name, data }); }
    receive(name, data) {
      if (name === 'connect') this.connected = true;
      if (name === 'disconnect') this.connected = false;
      for (const fn of [...(this.handlers.get(name) || [])]) fn(data);
    }
    disconnect() { this.receive('disconnect', 'client disconnect'); this.disconnected = true; }
  }
  class WebSocket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closeCount = 0; webSockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    send(data) { this.sent.push(data); }
    message(data) { this.onmessage?.({ data }); }
    fail() { this.onerror?.({}); }
    close() { this.closeCount++; this.readyState = 3; this.onclose?.({}); }
  }
  class Node {
    constructor(ctx, name) {
      this.ctx = ctx; this.name = name; this.connected = false; this.messages = [];
      this.port = { postMessage: msg => this.messages.push(msg), onmessage: null };
      nodes.push(this);
    }
    connect() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  class AudioContext {
    constructor() {
      this.state = options.suspended ? 'suspended' : 'running';
      this.destination = {};
      this.closed = false;
      this.audioWorklet = { addModule: url => options.module ? options.module(url, this) : Promise.resolve() };
      contexts.push(this);
    }
    resume() { this.state = 'running'; return options.resume ? options.resume(this) : Promise.resolve(); }
    close() { this.closed = true; this.state = 'closed'; return options.close ? options.close(this) : Promise.resolve(); }
    createScriptProcessor() { return new Node(this, 'fallback'); }
    createMediaStreamSource() { return new Node(this, 'source'); }
  }
  function newStream() {
    const track = { stopped: false, stop() { this.stopped = true; } };
    const stream = { track, getTracks: () => [track] };
    streams.push(stream);
    return stream;
  }
  let gumCalls = 0;
  const globals = {
    console,
    ArrayBuffer, Int16Array, Uint8Array, DataView, TextEncoder, TextDecoder,
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-' + String(++uuid).padStart(12, '0') },
    localStorage: { getItem: () => null, setItem() {} },
    WebSocket, AudioContext, AudioWorkletNode: Node,
    navigator: { mediaDevices: { getUserMedia() { gumCalls++; return options.microphone ? options.microphone() : Promise.resolve(newStream()); } } },
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({ user: { username: 'one', unit_id: 'UNIT-1' } }) })),
    document: { createElement: () => ({}), head: { appendChild: script => scripts.push(script) } },
  };
  if (!options.loadScript) globals.io = () => new Socket();
  globals.window = globals;
  vm.runInNewContext(source, globals, { filename: 'radio-client.js' });
  const client = new globals.RadioClient();
  t.after(() => client.destroy());
  return {
    client, sockets, webSockets, contexts, nodes, streams, scripts, timers, newStream,
    get gumCalls() { return gumCalls; },
    async authenticate() {
      await tick();
      const socket = sockets.at(-1);
      assert.ok(socket, 'signaling socket created');
      socket.receive('connect');
      socket.receive('authenticated', { unitId: 'UNIT-1' });
      await tick();
      return socket;
    },
    async acknowledge(channelId) {
      await tick();
      sockets.at(-1).receive('channel:members', { channelId, members: [] });
      await tick();
      return webSockets.at(-1);
    },
    async start(channelId = A) {
      const started = client.init({ serverUrl: 'https://radio.example.test', channelId });
      const socket = await this.authenticate();
      const ws = await this.acknowledge(channelId);
      ws.open();
      await started;
      return { socket, ws };
    },
    timeout(delay) {
      const entry = [...timers].find(([, value]) => value.delay === delay);
      assert.ok(entry, `timer ${delay} exists`);
      timers.delete(entry[0]);
      entry[1].fn();
    },
  };
}

function pcm(channelId, senderUnitId = 'UNIT-2') {
  return { type: 'audio', codec: 'pcm', sampleRate: 16000, channels: 1, frameSamples: 320,
    sequence: 1, channelId, senderUnitId, payload: Array(320).fill(100) };
}
function binary(channelId, senderUnitId = 'UNIT-2') {
  const ch = new TextEncoder().encode(channelId), sender = new TextEncoder().encode(senderUnitId);
  const data = new ArrayBuffer(7 + ch.length + sender.length + 640);
  const bytes = new Uint8Array(data), view = new DataView(data);
  let offset = 0;
  view.setUint8(offset++, 1); view.setUint32(offset, 1, true); offset += 4;
  view.setUint8(offset++, ch.length); bytes.set(ch, offset); offset += ch.length;
  view.setUint8(offset++, sender.length); bytes.set(sender, offset); offset += sender.length;
  for (; offset < bytes.length; offset += 2) view.setInt16(offset, 100, true);
  return data;
}
function enqueueCount(h) { return h.nodes.reduce((count, node) => count + node.messages.filter(msg => msg.type === 'enqueue').length, 0); }
function grant(h, socket, channelId = A, overrides = {}) {
  const request = socket.sent.filter(event => event.name === 'ptt:start').at(-1).data;
  socket.receive('ptt:granted', { channelId, requestId: request.requestId, targetDeviceId: h.client.getDeviceId(), ...overrides });
}

test('rapid A → B → C closes connecting sockets and ignores delayed open/message callbacks', async t => {
  const h = harness(t);
  const { ws: a } = await h.start();
  const bResult = observe(h.client.setChannel(B));
  const b = await h.acknowledge(B);
  const staleOpen = b.onopen, staleMessage = b.onmessage;
  const cResult = h.client.setChannel(C);
  const c = await h.acknowledge(C);
  c.open(); await cResult;
  staleOpen();
  staleMessage({ data: binary(B) });
  staleMessage({ data: binary(C) });
  c.message(binary(B));
  c.message(binary(C));
  cancelled(await bResult);
  assert.ok(a.closeCount > 0); assert.ok(b.closeCount > 0);
  assert.equal(h.webSockets.filter(ws => ws.readyState !== 3).length, 1);
  assert.equal(h.client.getChannelId(), C);
  assert.equal(h.client.getActiveChannelId(), C);
  assert.equal(enqueueCount(h), 1);
});

test('channel switch failure closes the old receiver and stays unready', async t => {
  const h = harness(t);
  const { socket, ws: a } = await h.start();
  a.message(binary(A));
  const result = observe(h.client.setChannel(B));
  assert.equal(h.client.getActiveChannelId(), null);
  assert.equal(await h.client.startPtt(), false);
  const b = await h.acknowledge(B); b.fail();
  assert.match((await result).error.message, /WebSocket connection failed/);
  assert.equal(h.client.getChannelId(), B);
  assert.equal(h.client.getActiveChannelId(), null);
  assert.ok(a.closeCount); assert.ok(b.closeCount);
  assert.ok(socket.sent.some(e => e.name === 'channel:leave' && e.data.channelId === B));
  assert.ok(h.nodes.some(n => n.messages.some(m => m.type === 'clear')));
});

test('JSON and binary receive reject foreign/missing channel, duplicate channel names across zones, and self echo', async t => {
  const h = harness(t);
  const { ws } = await h.start();
  ws.message(binary(B)); ws.message(binary(A, 'UNIT-1'));
  ws.message(JSON.stringify(pcm(B))); ws.message(JSON.stringify(pcm(A, 'UNIT-1')));
  ws.message(JSON.stringify({ ...pcm(A), channelId: undefined }));
  ws.message(JSON.stringify({ ...pcm(A), sampleRate: 48000 }));
  ws.message(binary(A)); ws.message(JSON.stringify(pcm(A)));
  assert.equal(enqueueCount(h), 2);
  ws.message(JSON.stringify({ type: 'heartbeat', ts: 123 }));
  assert.deepEqual(JSON.parse(ws.sent.at(-1)), { type: 'pong', ts: 123 });
});

test('PTT start, end, busy, member and emergency callbacks accept only confirmed selected channel', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const events = [];
  for (const name of ['pttStart', 'pttEnd', 'pttBusy', 'channelMembers', 'emergencyStart']) h.client.on(name, data => events.push({ name, data }));
  for (const name of ['ptt:start', 'ptt:end', 'ptt:busy', 'channel:members', 'emergency:start']) {
    socket.receive(name, { channelId: B, unitId: 'UNIT-2' });
    socket.receive(name, { unitId: 'UNIT-2' });
    socket.receive(name, { channelId: A, unitId: 'UNIT-2' });
  }
  assert.equal(events.length, 5);
  assert.ok(events.every(e => e.data.channelId === A));
  const result = observe(h.client.setChannel(B));
  socket.receive('ptt:start', { channelId: A, unitId: 'UNIT-2' });
  socket.receive('ptt:start', { channelId: B, unitId: 'UNIT-2' });
  assert.equal(events.length, 5);
  await h.client.destroy(); cancelled(await result);
});

test('a late join acknowledgement leaves an obsolete signaling room again', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const result = observe(h.client.setChannel(B)); await tick();
  const next = h.client.setChannel(C);
  await tick();
  socket.receive('channel:members', { channelId: B, members: [] });
  const ws = await h.acknowledge(C); ws.open(); await next;
  cancelled(await result);
  assert.equal(socket.sent.filter(e => e.name === 'channel:leave' && e.data.channelId === B).length, 2);
  assert.equal(h.webSockets.length, 2, 'no B audio socket starts after cancellation');
});

test('deselecting closes audio, flushes both playback queues and blocks PTT', async t => {
  const h = harness(t);
  const { ws } = await h.start();
  h.client._playback.fallbackQueue.push(new Int16Array(320));
  h.client._playback.fallbackOffset = 19;
  await h.client.setChannel(null);
  assert.ok(ws.closeCount);
  assert.equal(h.client._playback.fallbackQueue.length, 0);
  assert.equal(h.client._playback.fallbackOffset, 0);
  assert.equal(h.client.getActiveChannelId(), null);
  assert.equal(await h.client.startPtt(), false);
});

test('selection during initialization cannot activate the initial stale channel', async t => {
  const response = deferred();
  const h = harness(t, { fetch: () => response.promise });
  const initial = observe(h.client.init({ serverUrl: 'https://radio.example.test', channelId: A }));
  const selected = h.client.setChannel(B);
  response.resolve({ ok: true, json: async () => ({ user: { username: 'one', unit_id: 'UNIT-1' } }) });
  const socket = await h.authenticate();
  const ws = await h.acknowledge(B); ws.open(); await selected;
  cancelled(await initial);
  assert.deepEqual(socket.sent.filter(e => e.name === 'channel:join').map(e => e.data.channelId), [B]);
  assert.equal(h.client.getActiveChannelId(), B);
});

test('destroy during authentication fetch cannot create signaling or audio resources later', async t => {
  const response = deferred();
  const h = harness(t, { fetch: () => response.promise });
  const result = observe(h.client.init({ serverUrl: 'https://radio.example.test', channelId: A }));
  await h.client.destroy();
  response.resolve({ ok: true, json: async () => ({ user: { username: 'one' } }) });
  cancelled(await result);
  assert.equal(h.sockets.length, 0); assert.equal(h.contexts.length, 0); assert.equal(h.webSockets.length, 0);
});

test('destroy during signaling script load ignores a queued onload callback', async t => {
  const h = harness(t, { loadScript: true });
  const result = observe(h.client.init({ serverUrl: 'https://radio.example.test', channelId: A }));
  await tick();
  const lateLoad = h.scripts[0].onload;
  await h.client.destroy(); lateLoad();
  cancelled(await result);
  assert.equal(h.sockets.length, 0); assert.equal(h.webSockets.length, 0);
});

test('destroy during playback worklet initialization closes context without late nodes or fallback', async t => {
  const module = deferred();
  const h = harness(t, { module: () => module.promise });
  const result = observe(h.client.init({ serverUrl: 'https://radio.example.test', channelId: A }));
  await h.authenticate();
  assert.equal(h.contexts.length, 1);
  await h.client.destroy(); module.resolve();
  cancelled(await result);
  assert.ok(h.contexts[0].closed); assert.equal(h.nodes.length, 0); assert.equal(h.webSockets.length, 0);
});

test('destroy cancels an outstanding audio connection, including late open', async t => {
  const h = harness(t);
  const result = observe(h.client.init({ serverUrl: 'https://radio.example.test', channelId: A }));
  await h.authenticate();
  const ws = await h.acknowledge(A), lateOpen = ws.onopen;
  await h.client.destroy(); lateOpen();
  cancelled(await result);
  assert.ok(ws.closeCount); assert.equal(h.client.getActiveChannelId(), null); assert.equal(h.client.isConnected(), false);
});

test('signaling reconnect restores only the latest selected channel and rejects old receiver callbacks', async t => {
  const h = harness(t);
  const { socket, ws: a } = await h.start();
  const staleMessage = a.onmessage;
  socket.receive('disconnect', 'transport close');
  assert.equal(h.client.getActiveChannelId(), null);
  socket.receive('connect'); socket.receive('authenticated', {}); await tick();
  const ws = await h.acknowledge(A); ws.open(); await tick();
  staleMessage({ data: binary(A) }); ws.message(binary(A));
  assert.ok(a.closeCount); assert.equal(h.client.getActiveChannelId(), A); assert.equal(enqueueCount(h), 1);
});

test('unrelated or stale grants do not consume a pending selected-channel grant', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const started = h.client.startPtt();
  grant(h, socket, B);
  grant(h, socket, A, { requestId: 'old-request' });
  grant(h, socket, A, { targetDeviceId: 'other-device' });
  assert.equal(h.gumCalls, 0);
  grant(h, socket);
  assert.equal(await started, true); assert.equal(h.gumCalls, 1);
  await h.client.stopPtt(); assert.ok(h.streams[0].track.stopped);
});

test('stop while grant pending removes listeners and releases the captured channel', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const started = h.client.startPtt();
  await h.client.stopPtt();
  assert.equal(await started, false);
  grant(h, socket);
  assert.equal(h.gumCalls, 0);
  assert.equal(socket.handlers.get('ptt:granted').size, 1, 'only persistent UI event handler remains');
  assert.deepEqual(socket.sent.filter(e => e.name === 'ptt:end').map(e => e.data.channelId), [A]);
});

test('switch during microphone permission stops the late stream and cannot transmit on new channel', async t => {
  const mic = deferred();
  const h = harness(t, { microphone: () => mic.promise });
  const { socket } = await h.start();
  const started = h.client.startPtt(); grant(h, socket); await tick();
  const selected = h.client.setChannel(B);
  const ws = await h.acknowledge(B); ws.open(); await selected;
  const stream = h.newStream(); mic.resolve(stream); await tick();
  assert.equal(await started, false); assert.ok(stream.track.stopped); assert.equal(h.client.isTransmitting(), false);
  assert.equal(h.contexts.length, 1, 'cancelled permission result does not create capture context');
  assert.deepEqual(socket.sent.filter(e => e.name === 'ptt:end').map(e => e.data.channelId), [A]);
});

test('TX frames use the captured selected channel and stop releases A before asynchronous teardown', async t => {
  const closed = deferred();
  const h = harness(t, { close: ctx => ctx === h.contexts[1] ? closed.promise : Promise.resolve() });
  const { socket, ws: a } = await h.start();
  const started = h.client.startPtt(); grant(h, socket); assert.equal(await started, true);
  const capture = h.nodes.find(n => n.name === 'pcm-capture-processor');
  const oldSend = capture.port.onmessage;
  oldSend({ data: { type: 'pcmFrame', samples: new Int16Array(320) } });
  assert.equal(a.sent.length, 1);
  const bytes = new Uint8Array(a.sent[0]);
  assert.equal(new TextDecoder().decode(bytes.slice(6, 6 + bytes[5])), A);
  const stopping = h.client.stopPtt();
  assert.deepEqual(socket.sent.filter(e => e.name === 'ptt:end').map(e => e.data.channelId), [A]);
  const selected = h.client.setChannel(B);
  const b = await h.acknowledge(B); b.open(); await selected;
  oldSend({ data: { type: 'pcmFrame', samples: new Int16Array(320) } });
  assert.equal(a.sent.length, 1); assert.equal(b.sent.length, 0);
  closed.resolve(); await stopping;
});

test('PTT grant timeout settles and releases floor; audio-connect timeout closes pending receiver', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const started = observe(h.client.startPtt());
  h.timeout(3000);
  assert.match((await started).error.message, /grant timeout/);
  assert.equal(h.client.isTransmitting(), false);
  assert.ok(socket.sent.some(e => e.name === 'ptt:end' && e.data.channelId === A));
  const selected = observe(h.client.setChannel(B));
  const b = await h.acknowledge(B);
  h.timeout(10000);
  assert.match((await selected).error.message, /WebSocket connection timeout/);
  assert.ok(b.closeCount); assert.equal(h.client.getActiveChannelId(), null);
});

test('already-active selected-channel transmission is retained during join and exposed only after confirmation', async t => {
  const h = harness(t);
  const initial = h.client.init({ serverUrl: 'https://radio.example.test', channelId: A });
  const socket = await h.authenticate();
  const events = [];
  h.client.on('pttStart', data => events.push(data));
  socket.receive('channel:members', { channelId: A, members: [] });
  socket.receive('ptt:start', { channelId: A, unitId: 'UNIT-2' });
  socket.receive('ptt:start', { channelId: B, unitId: 'UNIT-3' });
  assert.equal(h.client.getReception(), null); assert.equal(events.length, 0);
  await tick(); h.webSockets.at(-1).open(); await initial;
  assert.deepEqual({ ...h.client.getReception() }, { channelId: A, unitId: 'UNIT-2' });
  assert.equal(events.length, 1); assert.equal(events[0].unitId, 'UNIT-2');
  socket.receive('ptt:end', { channelId: A, unitId: 'UNIT-3' });
  assert.equal(h.client.getReception().unitId, 'UNIT-2');
  socket.receive('ptt:end', { channelId: A, unitId: 'UNIT-2' });
  assert.equal(h.client.getReception(), null);
});

test('a transmission ending before audio confirmation is not replayed as active', async t => {
  const h = harness(t);
  await h.start();
  const selected = h.client.setChannel(B);
  const ws = await h.acknowledge(B);
  const socket = h.sockets[0];
  socket.receive('ptt:start', { channelId: B, unitId: 'UNIT-2' });
  socket.receive('ptt:end', { channelId: B, unitId: 'UNIT-2' });
  ws.open(); await selected;
  assert.equal(h.client.getReception(), null);
});

test('late acknowledgement after join timeout is removed and cannot start audio', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const selected = observe(h.client.setChannel(B)); await tick();
  h.timeout(10000);
  assert.match((await selected).error.message, /join timeout/);
  socket.receive('channel:members', { channelId: B, members: [] }); await tick();
  assert.equal(h.webSockets.length, 1); assert.equal(h.client.getActiveChannelId(), null);
  assert.equal(socket.sent.filter(e => e.name === 'channel:leave' && e.data.channelId === B).length, 2);
});

test('established audio error and close both revoke readiness and stop active PTT', async t => {
  for (const action of ['fail', 'close']) {
    const h = harness(t);
    const { socket, ws } = await h.start();
    const events = [];
    h.client.on('connectionChange', data => events.push(data));
    const started = h.client.startPtt(); grant(h, socket); assert.equal(await started, true);
    ws[action](); await tick();
    assert.equal(h.client.getActiveChannelId(), null);
    assert.equal(h.client.isTransmitting(), false);
    assert.ok(h.streams[0].track.stopped);
    assert.ok(events.some(e => e.ready === false && e.reason === (action === 'fail' ? 'audio_error' : 'audio_closed')));
  }
});

test('duplicate authenticated event does not start a second channel activation', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const joined = socket.sent.filter(e => e.name === 'channel:join').length;
  socket.receive('authenticated', {}); await tick();
  assert.equal(socket.sent.filter(e => e.name === 'channel:join').length, joined);
  assert.equal(h.webSockets.length, 1);
});

test('channel changes while disconnected recover only the latest desired channel on re-authentication', async t => {
  const h = harness(t);
  const { socket, ws: a } = await h.start();
  socket.receive('disconnect', 'transport close');
  const b = observe(h.client.setChannel(B));
  const c = observe(h.client.setChannel(C));
  cancelled(await b);
  assert.match((await c).error.message, /Signaling is disconnected/);
  socket.receive('connect'); socket.receive('authenticated', {}); await tick();
  const ws = await h.acknowledge(C); ws.open(); await tick();
  assert.deepEqual(socket.sent.filter(e => e.name === 'channel:join').map(e => e.data.channelId), [A, C]);
  assert.equal(h.client.getActiveChannelId(), C);
  assert.ok(a.closeCount); assert.equal(h.webSockets.filter(w => w.readyState === 1).length, 1);
});

test('a released request cannot grant a newer press on the same channel', async t => {
  const h = harness(t);
  const { socket } = await h.start();
  const first = h.client.startPtt();
  const oldRequest = socket.sent.filter(e => e.name === 'ptt:start').at(-1).data;
  await h.client.stopPtt(); assert.equal(await first, false);
  const second = h.client.startPtt();
  grant(h, socket, A, { requestId: oldRequest.requestId }); await tick();
  assert.equal(h.gumCalls, 0);
  grant(h, socket); assert.equal(await second, true);
  assert.equal(h.gumCalls, 1);
});
