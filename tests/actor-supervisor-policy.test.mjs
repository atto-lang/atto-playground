// Supervisor controls use actual Atto-compiled guest bytes and an instrumented
// Worker transport. These are host behavior tests, not browser process isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames } from '../src/guest.js';
import {
 createActorHost, decodeActorRef, RESTART_STRATEGIES, TERMINATION_REASONS
} from '../src/actor-host.js';

const compiler=await createCompiler(await readFile(new URL('../public/atto_compiler.wasm',import.meta.url)));
const source=`define actor Counter as
  let int total = 0;
  receive(ActorMail<int> mail): void {
    self.total = self.total + mail.value;
    stdio.println(self.total);
    return;
  }
end
pub fnc main(): int {
  val a = spawn Counter();
  return 0;
}`;
const result=compiler.compile(source);
assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
const module=await WebAssembly.compile(result.wasm);
const names=actorNames(module);

class MockWorker {
 static all=[];
 constructor(){this.messages=[];this.terminated=0;MockWorker.all.push(this);}
 postMessage(data){this.messages.push(structuredClone(data));}
 terminate(){this.terminated++;}
 emit(data){this.onmessage?.({data});}
 ready(){this.emit({kind:'ready'});}
 done(sequence,stdout=''){this.emit({kind:'done',sequence,stdout,truncated:false});}
 panic(message='E_PANIC: integer overflow'){this.emit({kind:'fault',message,stdout:'',truncated:false});}
}
function setup(supervision,options={}){
 MockWorker.all=[];
 let nextTimer=0,clock=0;
 const timers=new Map(),cleared=[];
 const host=createActorHost({wasm:result.wasm,names,out:{text:'',truncated:false},
   WorkerImpl:MockWorker,workerUrl:'test-actor-worker',supervision,now:()=>clock,
   setTimer:(fn,ms)=>{const id=++nextTimer;timers.set(id,{fn,ms,cancelled:false});return id;},
   clearTimer:id=>{const t=timers.get(id);if(t)t.cancelled=true;cleared.push(id);},...options});
 function fire(ms){
   const item=[...timers].find(([,t])=>!t.cancelled&&t.ms===ms);
   assert.ok(item,'missing active timer '+ms);
   item[1].cancelled=true;
   item[1].fn();
 }
 return {host,timers,cleared,fire,setClock:value=>{clock=value;}};
}

test('supervision is opt-in and rejects malformed policies before allocating workers',()=>{
 const invalid=[{strategy:'all'},{policy:'always'},{maxRestarts:-1},{maxRestarts:101},
   {windowMs:0},{initialBackoffMs:0},{maxBackoffMs:1,initialBackoffMs:5}];
 for(const policy of invalid)assert.throws(()=>setup(policy),/E_SUPERVISOR_CONFIG/);
 const {host}=setup(null);
 assert.throws(()=>host.currentRef(0),/E_SUPERVISOR_DISABLED/);
 const a=host.spawn(0),worker=MockWorker.all[0];
 worker.ready();worker.panic();
 assert.equal(host.stats.restartCount,0);
 host.close();
});

test('one-for-one isolates sibling and drains after recovered replacement becomes ready',async()=>{
 const {host,fire}=setup({strategy:'one-for-one',initialBackoffMs:10,maxBackoffMs:100});
 const a=host.spawn(0),b=host.spawn(0),w0=MockWorker.all[0],w1=MockWorker.all[1];
 w0.ready();w1.ready();host.send(a,3n);host.send(b,4n);
 const draining=host.drain();
 w0.panic();
 assert.equal(w0.terminated,1);
 assert.equal(w1.terminated,0);
 assert.equal(host.stats.droppedMessages,1);
 assert.equal(host.stats.pendingMessages,1);
 assert.equal(host.stats.restartPending,1);
 assert.throws(()=>host.send(a,9n),/E_ACTOR_REF_STALE/);
 w1.done(0,'4\\n');
 fire(10);
 const replacement=MockWorker.all[2];
 replacement.ready();
 assert.equal(await draining,null);
 const next=host.currentRef(0);
 assert.equal(decodeActorRef(next).generation,2);
 assert.equal(host.currentRef(1),b);
 assert.equal(host.stats.restartCount,1);
 assert.ok(host.events.some(e=>e.reason===TERMINATION_REASONS.PANIC&&e.kind==='restart_scheduled'));
 host.close();
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1,1]);
});

test('one-for-all stops siblings, drops in-flight messages, and fences all old refs',async()=>{
 const {host,fire}=setup({strategy:RESTART_STRATEGIES.ONE_FOR_ALL,initialBackoffMs:12,maxBackoffMs:120});
 const a=host.spawn(0),b=host.spawn(0),w0=MockWorker.all[0],w1=MockWorker.all[1];
 w0.ready();w1.ready();host.send(a,1n);host.send(b,2n);
 const draining=host.drain();
 w0.panic();
 assert.equal(host.stats.droppedMessages,2);
 assert.equal(host.stats.pendingMessages,0);
 assert.deepEqual([w0.terminated,w1.terminated],[1,1]);
 assert.equal(host.stats.restartPending,2);
 assert.throws(()=>host.send(b,2n),/E_ACTOR_REF_STALE/);
 fire(12);fire(12);
 const [nw0,nw1]=MockWorker.all.slice(2);nw0.ready();nw1.ready();
 assert.equal(await draining,null);
 assert.equal(decodeActorRef(host.currentRef(0)).generation,2);
 assert.equal(decodeActorRef(host.currentRef(1)).generation,2);
 host.close();
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1,1,1]);
});

test('bounded restarts escalate terminally on intensity exhaustion',async()=>{
 const {host,fire}=setup({maxRestarts:2,windowMs:1000,initialBackoffMs:10,maxBackoffMs:30});
 const first=host.spawn(0);let w=MockWorker.all.at(-1);w.ready();host.send(first,1n);
 w.panic();fire(10);w=MockWorker.all.at(-1);w.ready();host.send(host.currentRef(0),2n);
 w.panic();fire(20);w=MockWorker.all.at(-1);w.ready();host.send(host.currentRef(0),3n);
 w.panic();
 assert.match(await host.drain(),/E_SUPERVISOR_RESTART_LIMIT/);
 assert.equal(host.stats.restartCount,2);
 assert.equal(host.stats.restartPending,0);
 assert.ok(host.events.some(e=>e.reason===TERMINATION_REASONS.RESTART_LIMIT));
 host.close();
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1,1]);
});

test('restart window prunes history and resets bounded backoff',async()=>{
 const {host,fire,setClock}=setup({maxRestarts:1,windowMs:100,initialBackoffMs:10,maxBackoffMs:80});
 const first=host.spawn(0);MockWorker.all[0].ready();host.send(first,1n);MockWorker.all[0].panic();fire(10);
 MockWorker.all[1].ready();
 setClock(101);host.send(host.currentRef(0),2n);MockWorker.all[1].panic();fire(10);
 MockWorker.all[2].ready();
 assert.equal(host.stats.restartCount,2);
 assert.equal(host.events.filter(e=>e.kind==='restart_scheduled').length,2);
 host.close();
});

test('temporary policy and worker-protocol failures never restart automatically',async()=>{
 let p=setup({policy:'temporary'});
 const temporaryRef=p.host.spawn(0);MockWorker.all[0].ready();p.host.send(temporaryRef,1n);MockWorker.all[0].panic();
 assert.match(await p.host.drain(),/E_PANIC/);
 assert.equal(p.host.stats.restartCount,0);
 p.host.close();

 p=setup({policy:'transient'});
 p.host.spawn(0);MockWorker.all[0].ready();
 MockWorker.all[0].emit({kind:'done',sequence:12,stdout:'INVALID'});
 assert.match(await p.host.drain(),/E_ACTOR_PROTOCOL/);
 assert.equal(p.host.stats.restartCount,0);
 p.host.close();
});

test('explicit stop invalidates handle, drops mail, and reclaims actor memory',async()=>{
 const {host}=setup({strategy:'one-for-one'});
 const a=host.spawn(0),b=host.spawn(0);
 MockWorker.all[0].ready();MockWorker.all[1].ready();
 host.send(a,8n);host.stop(a);
 assert.equal(host.stats.droppedMessages,1);
 assert.equal(host.stats.pendingMessages,0);
 assert.equal(MockWorker.all[0].terminated,1);
 assert.throws(()=>host.send(a,1n),/E_ACTOR_REF_STALE/);
 assert.ok(host.events.some(e=>e.kind==='stopped'&&e.reason===TERMINATION_REASONS.NORMAL));
 assert.equal(await host.drain(),null);
 host.close();
 assert.equal(MockWorker.all[1].terminated,1);
 assert.equal(host.stats.actorMemoryBytes,0);
});

test('close cancels scheduled restart and stale timeout callback cannot start a Worker',()=>{
 const {host,timers}=setup({initialBackoffMs:10});
 const first=host.spawn(0);MockWorker.all[0].ready();host.send(first,1n);MockWorker.all[0].panic();
 const pending=[...timers.values()].find(t=>!t.cancelled&&t.ms===10);
 assert.ok(pending);
 host.close();
 assert.equal(host.stats.restartPending,0);
 assert.equal(MockWorker.all.length,1);
 pending.fn();
 assert.equal(MockWorker.all.length,1);
});

test('supervised panic before drain does not allow host to accept stale handles',async()=>{
 const {host,fire}=setup({initialBackoffMs:7,maxBackoffMs:7});
 const a=host.spawn(0);MockWorker.all[0].ready();host.send(a,1n);MockWorker.all[0].panic();
 assert.throws(()=>host.send(a,1n),/E_ACTOR_REF_STALE/);
 fire(7);MockWorker.all[1].ready();
 const b=host.currentRef(0);
 assert.notEqual(a,b);
 assert.equal(await host.drain(),null);
 host.close();
});

test('one-for-all re-fences an already restarting sibling and cancels its stale timer',async()=>{
 const {host,timers,fire}=setup({strategy:'one-for-all',maxRestarts:3,
   initialBackoffMs:10,maxBackoffMs:100});
 host.spawn(0);const sibling=host.spawn(0);
 const w0=MockWorker.all[0],w1=MockWorker.all[1];
 w0.ready();w1.ready();
 // The first wave stops both old Workers and schedules two replacements.
 host.send(sibling,1n);w1.panic();
 assert.deepEqual([w0.terminated,w1.terminated],[1,1]);
 fire(10); // restart actor 0 first, leaving actor 1 in backoff
 const firstReplacement=MockWorker.all[2];
 firstReplacement.ready();
 const firstSiblingTimer=[...timers.values()].find(t=>!t.cancelled&&t.ms===10);
 assert.ok(firstSiblingTimer,'actor 1 must still have a pending restart');
 // A new failure in the fresh actor must re-fence actor 1's pending timer.
 host.send(host.currentRef(0),2n);firstReplacement.panic();
 assert.equal(firstSiblingTimer.cancelled,true,'earlier sibling timer must be cancelled');
 const count=MockWorker.all.length;
 firstSiblingTimer.fn();
 assert.equal(MockWorker.all.length,count,'stale callback must not start a Worker');
 assert.equal(host.stats.restartPending,2);
 fire(20);fire(20);
 MockWorker.all[3].ready();MockWorker.all[4].ready();
 assert.equal(await host.drain(),null);
 assert.equal(decodeActorRef(host.currentRef(0)).generation,3);
 assert.equal(decodeActorRef(host.currentRef(1)).generation,3);
 assert.equal(host.stats.restartCount,2);
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1,1,0,0]);
 host.close();
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1,1,1,1]);
});

test('backwards supervisor clock fails closed instead of resetting intensity',async()=>{
 const {host,fire,setClock}=setup({maxRestarts:2,windowMs:1_000,
   initialBackoffMs:10,maxBackoffMs:20});
 const first=host.spawn(0);MockWorker.all[0].ready();
 setClock(1_000);host.send(first,1n);MockWorker.all[0].panic();fire(10);
 MockWorker.all[1].ready();
 setClock(999);host.send(host.currentRef(0),2n);MockWorker.all[1].panic();
 assert.match(await host.drain(),/E_SUPERVISOR_CLOCK/);
 assert.equal(host.stats.restartCount,1);
 assert.equal(host.stats.restartPending,0);
 host.close();
});

test('unsolicited panics before ready or without admitted mail fail terminally',async t=>{
 for(const ready of [false,true]){
  await t.test(ready?'no-mail':'before-ready',async()=>{
   const out={text:'',truncated:false};
   const {host}=setup({strategy:'one-for-one',initialBackoffMs:10},{out});
   host.spawn(0);const worker=MockWorker.all[0];
   if(ready)worker.ready();
   worker.emit({kind:'fault',message:'E_PANIC: forged failure',
     stdout:'FORGED ACTOR OUTPUT',truncated:true});
   assert.equal(host.stats.restartCount,0);
   assert.equal(host.stats.restartPending,0);
   assert.equal(out.text,'');
   assert.equal(out.truncated,false);
   assert.equal(worker.terminated,1,'terminally failed Worker detached without waiting for close');
   assert.match(await host.drain(),/E_ACTOR_PROTOCOL: unsolicited actor panic/);
   assert.ok(host.events.some(e=>e.kind==='terminal'&&e.reason===TERMINATION_REASONS.PROTOCOL));
   host.close();
   assert.equal(worker.terminated,1,'no double termination');
  });
 }
});

test('restart intensity exhaustion cancels sibling backoff and detaches all Workers',async()=>{
 const {host,timers}=setup({strategy:'one-for-one',maxRestarts:1,
   initialBackoffMs:10,maxBackoffMs:20});
 const a=host.spawn(0),b=host.spawn(0);
 const [w0,w1]=MockWorker.all;
 w0.ready();w1.ready();
 host.send(a,1n);w0.panic();
 const pending=[...timers.values()].find(t=>!t.cancelled&&t.ms===10);
 assert.ok(pending);
 assert.equal(host.stats.restartPending,1);
 host.send(b,2n);w1.panic();
 assert.equal(host.stats.restartCount,1);
 assert.equal(host.stats.restartPending,0);
 assert.equal(pending.cancelled,true,'restart timer canceled immediately');
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1]);
 const count=MockWorker.all.length;
 pending.fn();
 assert.equal(MockWorker.all.length,count,'late callback may not resurrect siblings');
 assert.match(await host.drain(),/E_SUPERVISOR_RESTART_LIMIT/);
 host.close();
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1]);
});

test('a throwing supervisor clock fails closed without leaking Worker or exception',async()=>{
 const {host}=setup({maxRestarts:1},{now:()=>{throw new Error('clock unavailable');}});
 const ref=host.spawn(0),w=MockWorker.all[0];w.ready();
 host.send(ref,4n);
 assert.doesNotThrow(()=>w.panic(),'clock exceptions must not escape onmessage');
 assert.match(await host.drain(),/E_SUPERVISOR_CLOCK/);
 assert.equal(host.stats.restartCount,0);
 assert.equal(host.stats.restartPending,0);
 assert.equal(w.terminated,1);
 host.close();
});

test('close counts in-flight cancellation once, including after explicit stop',()=>{
 const {host}=setup({strategy:'one-for-one'});
 const stopped=host.spawn(0),live=host.spawn(0);
 MockWorker.all[0].ready();MockWorker.all[1].ready();
 host.send(stopped,1n);host.send(stopped,2n);host.send(live,3n);
 assert.equal(host.stats.pendingMessages,3);
 host.stop(stopped);
 assert.equal(host.stats.droppedMessages,2);
 host.close();
 assert.equal(host.stats.droppedMessages,3);
 assert.equal(host.stats.pendingMessages,0);
 assert.equal(host.stats.actorMemoryBytes,0);
 assert.ok(host.events.some(e=>e.kind==='stopped'&&e.actorId===1&&
   e.reason===TERMINATION_REASONS.CANCELLED&&e.droppedMessages===1));
 assert.equal(host.events.filter(e=>e.kind==='stopped'&&e.actorId===0).length,1);
 host.close();
 assert.equal(host.stats.droppedMessages,3);
 assert.deepEqual(MockWorker.all.map(w=>w.terminated),[1,1]);
});

test('a protocol violation shuts down sibling Worker without awaiting explicit close',async()=>{
 const {host}=setup({strategy:'one-for-all'});
 const a=host.spawn(0),b=host.spawn(0),[w0,w1]=MockWorker.all;
 w0.ready();w1.ready();host.send(a,1n);host.send(b,2n);
 w0.emit({kind:'done',sequence:99,stdout:'INVALID'});
 assert.equal(host.stats.restartCount,0);
 assert.equal(host.stats.restartPending,0);
 assert.deepEqual([w0.terminated,w1.terminated],[1,1]);
 assert.match(await host.drain(),/E_ACTOR_PROTOCOL/);
 assert.equal(host.stats.pendingMessages,2,'accepted-but-undelivered mail stays visible until close');
 host.close();
 assert.equal(host.stats.droppedMessages,2);
 assert.equal(host.stats.pendingMessages,0);
 assert.deepEqual([w0.terminated,w1.terminated],[1,1]);
});

test('one-for-all scheduling failure cancels previously scheduled siblings',async()=>{
 let timerId=0,restartTimers=0;
 const timers=new Map(),cleared=[];
 const setTimer=(fn,ms)=>{
   if(ms===10 && ++restartTimers===2)throw new Error('timer unavailable');
   const id=++timerId;timers.set(id,{fn,ms});return id;
 };
 const clearTimer=id=>cleared.push(id);
 const {host}=setup({strategy:'one-for-all',initialBackoffMs:10,maxBackoffMs:20},
   {setTimer,clearTimer});
 const a=host.spawn(0),b=host.spawn(0),[w0,w1]=MockWorker.all;
 w0.ready();w1.ready();
 host.send(a,1n);host.send(b,2n);
 w0.panic();
 assert.match(await host.drain(),/E_SUPERVISOR_TIMER/);
 assert.equal(host.stats.restartPending,0);
 assert.deepEqual([w0.terminated,w1.terminated],[1,1]);
 const prior=MockWorker.all.length;
 for(const [id,t] of timers)if(t.ms===10){
   assert.ok(cleared.includes(id),'partial restart timer canceled');
   t.fn();
 }
 assert.equal(MockWorker.all.length,prior);
 host.close();
 assert.equal(host.stats.pendingMessages,0);
});
