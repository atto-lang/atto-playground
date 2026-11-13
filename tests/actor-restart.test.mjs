// Volatile supervisor restart acceptance. Stable ActorRef, fresh epochs and
// Worker identity must fence post-termination completions and async errors.
// This intentionally does NOT claim crash-persistent supervisor recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorHost } from '../src/actor-host.js';

const wasm = new Uint8Array([0,97,115,109,1,0,0,0]);

function scriptedWorkers() {
  class Worker {
    static instances = [];
    static alive = 0;
    static terminated = 0;
    constructor() {
      this.posts = [];
      this.dead = false;
      this.expected = 0;
      this.label = Worker.instances.length;
      Worker.instances.push(this);
      Worker.alive++;
    }
    postMessage(message) {
      if (this.dead) throw Error('E_TEST: send to dead worker');
      this.posts.push(message);
      if (message.kind === 'init') {
        this.generation = message.generation;
        queueMicrotask(() => this.emit({kind:'ready', generation:this.generation}));
      } else {
        queueMicrotask(() => {
          if (this.dead) return;
          assert.equal(message.sequence, this.expected++, 'worker must receive per-epoch FIFO');
          assert.equal(message.generation,this.generation);
          this.emit({kind:'done',generation:this.generation,sequence:message.sequence,
            stdout:String(message.value) + '\n'});
        });
      }
    }
    emit(data) {
      if (!this.dead) this.onmessage?.({data});
    }
    terminate() {
      if (this.dead) return;
      this.dead = true;
      Worker.alive--;
      Worker.terminated++;
    }
  }
  return Worker;
}

test('1,000 same-ref restarts discard old mail and fence forged new-epoch callbacks',async()=>{
  const WorkerImpl=scriptedWorkers();
  const out={text:'',truncated:false};
  const host=createActorHost({wasm,names:['A','Sibling'],out,WorkerImpl,workerUrl:'mock'});
  const a=host.spawn(0), sibling=host.spawn(1);
  assert.equal(a,0);assert.equal(sibling,1);
  let priorEpoch=WorkerImpl.instances[0].generation;
  for(let i=0;i<1000;i++) {
    const previous=WorkerImpl.instances.findLast(w=>w.label !== 1);
    const lateMessage=previous.onmessage, lateError=previous.onerror, lateDecode=previous.onmessageerror;
    host.send(a,BigInt(100_000+i)); // intentionally undelivered old-epoch mail
    assert.equal(host.restart(a),a,'actor ref stable across generations');
    const now=WorkerImpl.instances.at(-1);
    assert.ok(now.generation>priorEpoch,'supervisor epoch strictly increases');
    priorEpoch=now.generation;
    assert.equal(previous.dead,true,'previous Worker terminated');
    // Even an old Worker forging the NEW epoch must not pass identity fencing.
    lateMessage({data:{kind:'done',generation:now.generation,sequence:0,stdout:'ZOMBIE\n'}});
    lateMessage({data:{kind:'fault',generation:now.generation,message:'E_ACTOR: zombie fault',stdout:'POISON\n'}});
    lateError({preventDefault(){}});
    lateDecode({});
    host.send(sibling,BigInt(i));
    if(i%31===0) await Promise.resolve(); // deterministic interleaved sibling progress
  }
  host.send(a,9001n);
  assert.equal(await host.drain(),null,'new actor and sibling both drain without stale faults');
  const lines=out.text.trim().split('\n');
  assert.equal(lines.length,1001,'exact 1000 sibling ACKs + one current-generation ACK');
  assert.deepEqual(lines.map(Number).filter(n=>n!==9001),
    Array.from({length:1000},(_,i)=>i),'healthy sibling retains FIFO across restarts');
  assert.equal(lines.filter(x=>x==='9001').length,1,'latest incarnation completes once');
  assert.doesNotMatch(out.text,/ZOMBIE|POISON|100000/);
  host.close();
  assert.equal(WorkerImpl.alive,0,'no leaked Workers');
  assert.equal(WorkerImpl.terminated,1002,'1000 discarded + 2 final Workers, exactly once');
});

test('explicit restart after actor failure clears only its generation fault',async()=>{
  const WorkerImpl=scriptedWorkers();
  const out={text:'',truncated:false};
  const host=createActorHost({wasm,names:['A'],out,WorkerImpl,workerUrl:'mock'});
  const ref=host.spawn(0),old=WorkerImpl.instances[0];
  const oldError=old.onerror,oldMessage=old.onmessage;
  old.emit({kind:'fault',generation:old.generation,message:'E_PANIC: prior failure',stdout:'OLD\n'});
  assert.equal(host.restart(ref),ref);
  const next=WorkerImpl.instances.at(-1);
  oldError({preventDefault(){}});
  oldMessage({data:{kind:'fault',generation:next.generation,message:'E_ACTOR: poisoned'}});
  host.send(ref,42n);
  assert.equal(await host.drain(),null,'old error is not reported after explicit restart');
  assert.equal(out.text,'OLD\n42\n','only already-validated prior output may remain');
  host.close();
  assert.equal(WorkerImpl.alive,0);
});

test('restarting a healthy actor never clears another actor failure',async()=>{
  const WorkerImpl=scriptedWorkers();
  const out={text:'',truncated:false};
  const host=createActorHost({wasm,names:['A'],out,WorkerImpl,workerUrl:'mock'});
  const a=host.spawn(0), b=host.spawn(0);
  const culprit=WorkerImpl.instances[1];
  culprit.emit({kind:'fault',generation:culprit.generation,message:'E_PANIC: sibling failed'});
  host.restart(a);
  assert.equal(await host.drain(),'E_PANIC: sibling failed in actor A#1');
  host.close();
  assert.equal(WorkerImpl.alive,0);
});

test('restart is forbidden after drain sealing and close, and invalid refs fail closed',async()=>{
  const WorkerImpl=scriptedWorkers(),out={text:'',truncated:false};
  const host=createActorHost({wasm,names:['A'],out,WorkerImpl,workerUrl:'mock'});
  const a=host.spawn(0);
  assert.throws(()=>host.restart(-1),/invalid actor reference/);
  assert.throws(()=>host.restart(1),/invalid actor reference/);
  const drain=host.drain();
  assert.throws(()=>host.restart(a),/sealed for drain/);
  assert.equal(await drain,null);
  host.close();
  assert.throws(()=>host.restart(a),/actor host closed/);
  assert.equal(WorkerImpl.alive,0);
});

test('restart worker startup exception terminates new Worker and reports fault',async()=>{
  const WorkerImpl=scriptedWorkers();
  const out={text:'',truncated:false};
  const host=createActorHost({wasm,names:['A'],out,WorkerImpl,workerUrl:'mock'});
  const a=host.spawn(0);
  const original=WorkerImpl.prototype.postMessage;
  WorkerImpl.prototype.postMessage=function(message) {
    if(message.kind==='init' && this.label>0) throw Error('E_TEST: init admission failed');
    return original.call(this,message);
  };
  assert.throws(()=>host.restart(a),/init admission failed/);
  assert.equal(await host.drain(),'E_ACTOR_RESTART: worker launch failed in actor A#0');
  host.close();
  assert.equal(WorkerImpl.alive,0);
  assert.equal(WorkerImpl.terminated,2);
});


test('actor fault terminates its Worker immediately, without terminating healthy siblings',async()=>{
  const WorkerImpl=scriptedWorkers();
  const out={text:'',truncated:false};
  const host=createActorHost({wasm,names:['A'],out,WorkerImpl,workerUrl:'mock'});
  const a=host.spawn(0),b=host.spawn(0);
  const broken=WorkerImpl.instances[0],healthy=WorkerImpl.instances[1];
  broken.emit({kind:'fault',generation:broken.generation,
    message:'E_PANIC: actor stack exhausted'});
  assert.equal(broken.dead,true,'failed actor must stop CPU immediately, before sibling drain');
  assert.equal(healthy.dead,false,'healthy sibling must remain live');
  host.send(b,99n);
  assert.equal(await host.drain(),'E_PANIC: actor stack exhausted in actor A#0');
  assert.equal(out.text,'99\n','healthy sibling still processes queued mailbox');
  host.close();
  assert.equal(WorkerImpl.alive,0);
  assert.equal(WorkerImpl.terminated,2,'failed worker not double-terminated on close');
});
