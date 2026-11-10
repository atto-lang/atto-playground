import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createActorHost, guestMemoryBudgetBytes, MAX_TOTAL_ACTOR_MEMORY_BYTES,
  MAX_TOTAL_PENDING_MESSAGES, MAX_ACTOR_INIT_MS, MAX_ACTOR_WASM_BYTES
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

test('Wasm import-section memories never bypass local-memory quota admission',()=>{
  // Valid Wasm memory imports carry no local section 5, so the old parser
  // treated them as zero-byte guests even if their memory could grow.
  const header=[0,97,115,109,1,0,0,0];
  const imports=[1,3,101,110,118,3,109,101,109,2]; // env.mem memory
  const unbounded=new Uint8Array([...header,2,12,...imports,0,1]);
  const bounded=new Uint8Array([...header,2,13,...imports,1,1,1]);
  assert.equal(WebAssembly.validate(unbounded),true,'fixture must be valid Wasm');
  assert.equal(WebAssembly.validate(bounded),true);
  assert.equal(WebAssembly.Module.imports(new WebAssembly.Module(unbounded))[0].kind,'memory');
  for(const wasm of [unbounded,bounded]){
    assert.throws(()=>guestMemoryBudgetBytes(wasm),/imported memories are not admitted/);
    assert.throws(()=>hostFor(wasm),/imported memories are not admitted/);
    assert.equal(ManualWorker.instances.length,0,'untrusted module rejected before Worker allocation');
  }
});

test('malformed non-memory sections and oversized modules fail admission before a Worker',()=>{
  // The old parser skipped unknown sections without validating their syntax.
  const invalid=new Uint8Array([0,97,115,109,1,0,0,0,1,1,1]);
  assert.equal(WebAssembly.validate(invalid),false);
  assert.throws(()=>guestMemoryBudgetBytes(invalid),/invalid or unsupported Wasm module/);
  assert.throws(()=>hostFor(invalid),/invalid or unsupported Wasm module/);
  assert.equal(ManualWorker.instances.length,0);
  const oversized=new Uint8Array(MAX_ACTOR_WASM_BYTES+1);
  oversized.set([0,97,115,109,1,0,0,0]);
  assert.throws(()=>guestMemoryBudgetBytes(oversized),/exceeds 1 MiB admission limit/);
  assert.throws(()=>hostFor(oversized),/exceeds 1 MiB admission limit/);
  assert.equal(ManualWorker.instances.length,0);
});

test('actor quota snapshot defeats mutation of caller-owned Wasm before spawn and restart',()=>{
  const bytes=memoryModule(1,1,1);
  const host=hostFor(bytes);
  // A shared mutable source could be changed after the 64 KiB quota check,
  // making each actor instantiate a 1 MiB heap while charged only 64 KiB.
  bytes[12]=16;bytes[13]=16;
  assert.equal(guestMemoryBudgetBytes(bytes),1_048_576);
  const refs=[];
  for(let i=0;i<16;i++)refs.push(host.spawn(0));
  assert.equal(host.stats.actorMemoryBytes,16*65_536);
  assert.equal(ManualWorker.instances.length,16);
  for(const worker of ManualWorker.instances){
    const init=worker.messages[0];
    assert.equal(init.kind,'init');
    assert.equal(init.wasm[12],1);
    assert.equal(init.wasm[13],1);
    assert.notEqual(init.wasm.buffer,bytes.buffer,'each Worker receives an independent validated snapshot');
  }
  ManualWorker.instances[0].ready();
  const next=host.restart(refs[0]);
  assert.notEqual(next,refs[0]);
  assert.equal(ManualWorker.instances[16].messages[0].wasm[12],1,'restart uses the same admission snapshot');
  assert.equal(host.stats.actorMemoryBytes,16*65_536);
  host.close();
  assert.equal(host.stats.actorMemoryBytes,0);
});

test('actor type table is snapshotted and validated at host admission',async()=>{
  const bytes=memoryModule(1,1,1),names=['Original'];
  const host=hostFor(bytes,{names});
  names[0]='Spoofed';
  names.push('Escalated');
  assert.throws(()=>host.spawn(1),/unknown actor type/);
  const handle=host.spawn(0),worker=ManualWorker.instances[0];
  assert.equal(handle,0);
  worker.onmessage({data:{kind:'unexpected'}});
  assert.match(await host.drain(),/in actor Original#0/);
  host.close();
  assert.throws(()=>hostFor(bytes,{names:['invalid name']}),/valid actor table/);
  assert.equal(ManualWorker.instances.length,0);
});
