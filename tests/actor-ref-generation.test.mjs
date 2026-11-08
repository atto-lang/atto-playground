import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames } from '../src/guest.js';
import { createActorHost, encodeActorRef, decodeActorRef, MAX_ACTOR_GENERATION } from '../src/actor-host.js';
const compiler=await createCompiler(await readFile(new URL('../public/atto_compiler.wasm',import.meta.url)));
const source=`define actor Counter as
 let int total = 0;
 receive(ActorMail<int> mail): void { self.total=self.total+mail.value; return; }
end
pub fnc main(): int { val c=spawn Counter(); return 0; }`;
const compiled=compiler.compile(source);assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
const module=await WebAssembly.compile(compiled.wasm);
class WorkerMock{
 static all=[];
 constructor(){this.messages=[];this.terminated=0;WorkerMock.all.push(this);}
 postMessage(m){this.messages.push(structuredClone(m));}
 terminate(){this.terminated++;}
 emit(data){this.onmessage?.({data});}
 ready(){this.emit({kind:'ready'});}
 done(sequence){this.emit({kind:'done',sequence});}
}
function make(){WorkerMock.all=[];return createActorHost({wasm:compiled.wasm,names:actorNames(module),out:{text:'',truncated:false},WorkerImpl:WorkerMock,workerUrl:'test'});}
test('ActorRef i32 encodes slot and nonzero bounded generation',()=>{
 for(let slot=0;slot<16;slot++)for(const generation of [1,2,99,MAX_ACTOR_GENERATION])assert.deepEqual(decodeActorRef(encodeActorRef(slot,generation)),{slot,generation});
 for(const [slot,generation] of [[-1,1],[16,1],[0,0],[0,MAX_ACTOR_GENERATION+1]])assert.throws(()=>encodeActorRef(slot,generation),/invalid actor slot or generation/);
 assert.deepEqual(decodeActorRef(0),{slot:0,generation:1});
 assert.deepEqual(decodeActorRef(15),{slot:15,generation:1});
 for(const h of [-1,0x80000000,NaN,1.5])assert.equal(decodeActorRef(h),null);
});
test('restart increments generation and rejects stale handles',()=>{
 const host=make(),old=host.spawn(0),w1=WorkerMock.all[0];w1.ready();
 const next=host.restart(old),w2=WorkerMock.all[1];w2.ready();
 assert.deepEqual(decodeActorRef(old),{slot:0,generation:1});assert.deepEqual(decodeActorRef(next),{slot:0,generation:2});
 assert.throws(()=>host.send(old,1n),/E_ACTOR_REF_STALE/);assert.doesNotThrow(()=>host.send(next,1n));assert.equal(w1.terminated,1);
 host.close();assert.equal(w2.terminated,1);
});
test('late callbacks from previous generation cannot mutate current actor',()=>{
 const host=make(),old=host.spawn(0),w1=WorkerMock.all[0];w1.ready();const next=host.restart(old),w2=WorkerMock.all[1];w2.ready();
 w1.emit({kind:'fault',message:'E_PANIC: stale failure'});w1.emit({kind:'done',sequence:0,stdout:'stale'});
 assert.equal(host.stats.pendingMessages,0);host.send(next,4n);w2.done(0);assert.equal(host.stats.pendingMessages,0);host.close();
});
test('restart requires old mailbox to be fully drained',()=>{
 const host=make(),ref=host.spawn(0),w=WorkerMock.all[0];w.ready();host.send(ref,1n);
 assert.throws(()=>host.restart(ref),/E_ACTOR_RESTART_BUSY/);w.done(0);assert.equal(decodeActorRef(host.restart(ref)).generation,2);host.close();
});
test('restart initialization failure invalidates old generation and faults',()=>{
 class ThrowWorker extends WorkerMock{postMessage(m){if(WorkerMock.all.length===2)throw new Error('no init');super.postMessage(m);}}
 WorkerMock.all=[];const host=createActorHost({wasm:compiled.wasm,names:actorNames(module),out:{text:'',truncated:false},WorkerImpl:ThrowWorker,workerUrl:'test'});
 const old=host.spawn(0);WorkerMock.all[0].ready();assert.throws(()=>host.restart(old),/no init/);
 assert.throws(()=>host.send(old,1n),/E_ACTOR_REF_STALE/);assert.equal(WorkerMock.all[0].terminated,1);host.close();
});
test('generation never wraps into a stale valid reference',()=>assert.throws(()=>encodeActorRef(0,MAX_ACTOR_GENERATION+1),/invalid actor slot or generation/));
