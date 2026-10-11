const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { fetchAccessibleChannels } = require('./gateway-channels.cjs');
const channel = { id: 7, name: 'DISPATCH', zone: 'TEST', room_key: 'TEST__DISPATCH' };
function fixture(status, data) {
  const calls = [];
  const context = vm.createContext({ fetch: async (url, options) => {
    calls.push({url, options});
    return { status, ok: status === 200, json: async () => data };
  }});
  return { calls, run: () => vm.runInContext(`(${fetchAccessibleChannels.toString()})()`, context) };
}
test('reads the actual channel envelope using the authenticated accessible endpoint', async () => {
  const f = fixture(200, {channels:[channel]});
  assert.deepEqual(await f.run(), [channel]);
  assert.equal(f.calls[0].url, '/api/channels/');
  assert.equal(f.calls[0].options.credentials, 'include');
});
test('empty access list remains empty without falling back to administrator channels', async () => {
  const f = fixture(200, {channels:[]});
  assert.deepEqual(await f.run(), []);
  assert.equal(f.calls.length, 1);
});
for (const [status, message] of [[401,/Log into/],[403,/cannot access/],[500,/HTTP 500/]]) {
  test(`HTTP ${status} is reported instead of becoming an empty list`, async () => {
    const f=fixture(status, {});
    await assert.rejects(f.run(),message);
    assert.equal(f.calls.length,1);
  });
}
test('malformed response fails explicitly', async () => {
  await assert.rejects(fixture(200,{unexpected:[]}).run(), /Invalid channel response/);
});
function gateway(fetchGatewayChannels) {
  const nodes = {};
  const get = id => nodes[id] ||= {options:[],replaceChildren(){this.options=[]},append(x){this.options.push(x)}};
  const context=vm.createContext({ document:{getElementById:get,createElement:()=>({}),addEventListener:()=>{}},window:{electronAPI:{fetchGatewayChannels}} });
  vm.runInContext(fs.readFileSync(`${__dirname}/gateway.js`,'utf8'),context);
  return {nodes,get,run:()=>vm.runInContext('loadGatewayChannels()',context)};
}
test('gateway renders channel name and canonical key; reload removes stale channels', async()=>{
  let channels=[channel];
  const g=gateway(async()=>channels);
  await g.run();
  assert.equal(g.nodes.channel.options[1].value,channel.room_key);
  assert.equal(g.nodes.channel.options[1].textContent,'DISPATCH (TEST)');
  channels=[]; await g.run();
  assert.equal(g.nodes.channel.options.length,1);
  assert.equal(g.nodes.channel.options[0].textContent,'No accessible channels');
});
test('gateway shows fetch failure and can recover after login', async()=>{
  let failed=true;
  const g=gateway(async()=>{if(failed)throw Error('Login expired');return [channel]});
  await assert.rejects(g.run(),/Login expired/);
  assert.equal(g.nodes.channel.options[0].textContent,'Unable to load channels');
  assert.equal(g.nodes.networkStatus.textContent,'Login expired');
  failed=false;await g.run();
  assert.equal(g.nodes.channel.options[1].value,channel.room_key);
});
const main=fs.readFileSync(`${__dirname}/main.js`,'utf8');
function connectScript(selected) {
  const start=main.indexOf('const result = await gatewayInvoke(`(async () => {');
  const end=main.indexOf('`);',start);
  const template=main.slice(main.indexOf('`',start),end+1);
  return vm.runInNewContext(template,{channel:selected,fetchAccessibleChannels,JSON});
}
test('connection preflight accepts accessible channel and rejects a different channel',async()=>{
  let opened=0;
  class WebSocket {
    constructor(){opened++}
    addEventListener(type,fn){if(type==='open')fn()}
  }
  const context={window:{__audioTransportManager:{},__signalingManager:{authenticated:true}},fetch:async()=>({ok:true,status:200,json:async()=>({channels:[channel]})}),location:{origin:'https://example.test',protocol:'https:'},URL,WebSocket,setTimeout,clearTimeout};
  const allowed=await vm.runInNewContext(connectScript(channel.room_key),context);
  assert.equal(allowed.success,true);
  assert.equal(opened,1);
  context.window.__cf33Gateway=null;
  const denied=await vm.runInNewContext(connectScript('OTHER__DISPATCH'),context);
  assert.equal(denied.success,false);
  assert.match(denied.error,/unavailable/);
  assert.equal(opened,1);
});
test('connection preflight preserves expired-session failure',async()=>{
  const result=await vm.runInNewContext(connectScript(channel.room_key),{window:{__audioTransportManager:{},__signalingManager:{authenticated:true}},fetch:async()=>({ok:false,status:401})});
  assert.equal(result.success,false);
  assert.match(result.error,/Log into/);
});
