import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createActorHost, guestMemoryBudgetBytes, MAX_TOTAL_ACTOR_MEMORY_BYTES,
  MAX_TOTAL_PENDING_MESSAGES, MAX_ACTOR_INIT_MS
} from '../src/actor-host.js';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames, describePanic, guestImports } from '../src/guest.js';

const compiler = await createCompiler(await readFile(new URL('../public/atto_compiler.wasm', import.meta.url)));
const encoder = new TextEncoder();
const memoryModule = (flags, min, max) => new Uint8Array([
  0,97,115,109,1,0,0,0, 5, (max === null ? 3 : 4), 1, flags, min,
  ...(max === null ? [] : [max])
]);

class ManualWorker {
  static instances=[];
  constructor(){this.messages=[];this.terminated=0;ManualWorker.instances.push(this);}
  postMessage(m){this.messages.push(structuredClone(m));}
  terminate(){this.terminated++;}
  ready(){this.onmessage?.({data:{kind:'ready'}});}
  done(sequence){this.onmessage?.({data:{kind:'done',sequence}});}
}
function hostFor(wasm, options={}) {
  ManualWorker.instances=[];
  return createActorHost({wasm,names:['A'],out:{text:'',truncated:false},
    WorkerImpl:ManualWorker,workerUrl:'test-worker',...options});
}

test('fixed guest memory is charged at declared maximum, not current use',()=>{
  assert.equal(guestMemoryBudgetBytes(new Uint8Array([0,97,115,109,1,0,0,0])),0);
  assert.equal(guestMemoryBudgetBytes(memoryModule(1,16,16)),1_048_576);
  assert.equal(guestMemoryBudgetBytes(memoryModule(1,1,1)),65_536);
  assert.throws(()=>guestMemoryBudgetBytes(memoryModule(0,16,null)),/fixed maximum/);
  assert.throws(()=>guestMemoryBudgetBytes(memoryModule(1,17,17)),/at most 16 pages/);
  assert.throws(()=>guestMemoryBudgetBytes(memoryModule(1,0,16)),/fixed and at most/);
});

test('aggregate actor memory is reserved before Worker creation',()=>{
  const wasm=memoryModule(1,16,16);
  const host=hostFor(wasm);
  for(let i=0;i<8;i++) host.spawn(0);
  assert.equal(host.stats.actorMemoryBytes,MAX_TOTAL_ACTOR_MEMORY_BYTES);
  const created=ManualWorker.instances.length;
  assert.throws(()=>host.spawn(0),/E_ACTOR_TOTAL_MEMORY/);
  assert.equal(ManualWorker.instances.length,created,'rejected actor must not allocate a Worker');
  assert.equal(host.stats.actorMemoryBytes,MAX_TOTAL_ACTOR_MEMORY_BYTES);
  host.close();
});

test('aggregate pending mail counts all actors and releases capacity only on matching done',()=>{
  const host=hostFor(new Uint8Array([0,97,115,109,1,0,0,0]));
  const a=host.spawn(0),b=host.spawn(0),c=host.spawn(0);
  ManualWorker.instances[0].ready(); ManualWorker.instances[1].ready(); ManualWorker.instances[2].ready();
  for(let i=0;i<10_000;i++) host.send(a,BigInt(i));
  for(let i=0;i<10_000;i++) host.send(b,BigInt(i));
  assert.equal(host.stats.pendingMessages,MAX_TOTAL_PENDING_MESSAGES);
  assert.throws(()=>host.send(c,10001n),/E_ACTOR_TOTAL_MAILBOX/);
  ManualWorker.instances[0].done(0);
  assert.equal(host.stats.pendingMessages,MAX_TOTAL_PENDING_MESSAGES-1);
  assert.doesNotThrow(()=>host.send(c,10001n));
  assert.equal(host.stats.pendingMessages,MAX_TOTAL_PENDING_MESSAGES);
  host.close();
  assert.equal(host.stats.actorMemoryBytes,0);
  assert.equal(host.stats.pendingMessages,0);
});

test('actor initialization timeout fails drain and cleanup clears its timer',async()=>{
  let timerCallback=null,cleared=[];
  const host=hostFor(new Uint8Array([0,97,115,109,1,0,0,0]),{
    initTimeoutMs:MAX_ACTOR_INIT_MS,
    setTimer:(fn,ms)=>{timerCallback=fn;assert.equal(ms,MAX_ACTOR_INIT_MS);return 123;},
    clearTimer:id=>cleared.push(id)
  });
  host.spawn(0);
  const draining=host.drain();
  timerCallback();
  assert.match(await draining,/E_ACTOR_INIT_TIMEOUT/);
  host.close();
  assert.deepEqual(cleared,[123]);
  assert.equal(ManualWorker.instances[0].terminated,1);
});

test('invalid timeout configuration fails before any Worker is allocated',()=>{
  assert.throws(()=>hostFor(new Uint8Array([0,97,115,109,1,0,0,0]),{initTimeoutMs:0}),/invalid actor init timeout/);
  assert.equal(ManualWorker.instances.length,0);
});

test('real source-compiled actor module memory budget reflects fixed compiler heap',async()=>{
  const source=`define actor A as
  receive(ActorMail<int> mail): void {
    stdio.println("x");
    return;
  }
end
pub fnc main(): int { val a = spawn A(); return 0; }`;
  const compiled=compiler.compile(source);
  assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
  assert.equal(guestMemoryBudgetBytes(compiled.wasm),65_536);
});
