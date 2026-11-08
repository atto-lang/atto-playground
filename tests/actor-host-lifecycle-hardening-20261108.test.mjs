import test from 'node:test';
import assert from 'node:assert/strict';
import {createActorHost} from '../src/actor-host.js';

// Host-only Worker double: no claim of browser process, Wasm guest or tenant isolation.
class ManualWorker {
  static instances = [];
  constructor() {
    this.sent = [];
    this.terminated = 0;
    ManualWorker.instances.push(this);
  }
  postMessage(msg) {
    if (this.throwOnInit && msg.kind === 'init') throw Error('init rejected');
    if (this.throwOnMail && msg.kind === 'mail') throw Error('mail rejected');
    this.sent.push(msg);
  }
  terminate() { this.terminated++; }
  reply(msg) { this.onmessage?.({data: msg}); }
}
function fresh(WorkerImpl=ManualWorker) {
  ManualWorker.instances = [];
  return createActorHost({
    wasm: new Uint8Array([0,97,115,109,1,0,0,0]),
    names: ['W'], out: {text:'',truncated:false},
    WorkerImpl, workerUrl: 'test-worker.js'
  });
}
test('every spawned actor gets a distinct Worker object and module-byte copy', () => {
  const h=fresh();
  const first=h.spawn(0), second=h.spawn(0);
  assert.equal(first,0);
  assert.equal(second,1);
  assert.notEqual(ManualWorker.instances[0],ManualWorker.instances[1]);
  const a=ManualWorker.instances[0].sent[0].wasm;
  const b=ManualWorker.instances[1].sent[0].wasm;
  assert.notEqual(a,b);
  a[0]=255;
  assert.equal(b[0],0);
  h.close();
  assert.deepEqual(ManualWorker.instances.map(w=>w.terminated),[1,1]);
});

test('pending parallel drains terminate on explicit close without hanging', async () => {
  const h=fresh();
  const a=h.spawn(0), b=h.spawn(0);
  h.send(a,1n);
  h.send(b,2n);
  const p1=h.drain(),p2=h.drain();
  h.close();
  h.close();
  assert.equal(await p1,'E_ACTOR_CANCELLED: actor host closed');
  assert.equal(await p2,'E_ACTOR_CANCELLED: actor host closed');
  assert.equal(await h.drain(),'E_ACTOR_CANCELLED: actor host closed');
  assert.deepEqual(ManualWorker.instances.map(w=>w.terminated),[1,1]);
  assert.throws(()=>h.spawn(0),/host closed/);
  assert.throws(()=>h.send(a,3n),/host closed/);
});

test('a done before ready, and duplicate ready, fail the actor protocol', async () => {
  let h=fresh();
  h.spawn(0);
  h.send(0,7n);
  ManualWorker.instances[0].reply({kind:'done',sequence:0});
  assert.match(await h.drain(),/E_ACTOR_PROTOCOL/);
  h.close();

  h=fresh();
  h.spawn(0);
  ManualWorker.instances[0].reply({kind:'ready'});
  ManualWorker.instances[0].reply({kind:'ready'});
  assert.match(await h.drain(),/E_ACTOR_PROTOCOL/);
  h.close();
});

test('failed Worker init is terminated and leaves no admitted actor',async()=>{
  class BadInit extends ManualWorker {
    constructor(){ super();this.throwOnInit=true; }
  }
  const h=fresh(BadInit);
  assert.throws(()=>h.spawn(0),/init rejected/);
  assert.equal(h.count,0);
  assert.equal(ManualWorker.instances[0].terminated,1);
  assert.match(await h.drain(),/E_ACTOR_INIT/);
  h.close();
  assert.equal(ManualWorker.instances[0].terminated,1);
});

test('failed Worker send cannot masquerade as successful mail admission',async()=>{
  const h=fresh();
  h.spawn(0);
  ManualWorker.instances[0].reply({kind:'ready'});
  ManualWorker.instances[0].throwOnMail=true;
  assert.throws(()=>h.send(0,42n),/mail rejected/);
  assert.match(await h.drain(),/E_ACTOR_SEND/);
  h.close();
  assert.equal(ManualWorker.instances[0].terminated,1);
});

test('adapter reusing one Worker object cannot merge two actor heaps',async()=>{
  const shared=new ManualWorker();
  class SharedWorker { constructor(){return shared;} }
  const h=fresh(SharedWorker);
  assert.equal(h.spawn(0),0);
  assert.throws(()=>h.spawn(0),/E_ACTOR_ISOLATION/);
  assert.match(await h.drain(),/E_ACTOR_ISOLATION/);
  h.close();
  assert.equal(shared.terminated,1);
});
