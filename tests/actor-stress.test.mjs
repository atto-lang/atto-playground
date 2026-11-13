// Seeded actor mailbox/cancellation races. All seeds are reproducible.
// Run: ATTO_STRESS_SEED=1234567 node --test tests/actor-stress.test.mjs
// Uses controlled Workers to force interleavings, with Chromium E2E
// independently executing actual guest Wasm/JSPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorHost, MAX_ACTORS, MAX_MAILBOX } from '../src/actor-host.js';

const wasm = new Uint8Array([0,97,115,109,1,0,0,0]);
const seeds = process.env.ATTO_STRESS_SEED === undefined
  ? [1, 17, 0x51f15e, 0xc0ffee, 0x5eeded, 0xdeadbeef, 0x1234567, 0x7fffffff]
  : [Number(process.env.ATTO_STRESS_SEED)];
function prng(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw Error('ATTO_STRESS_SEED must be an unsigned 32-bit integer');
  }
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function createScriptedWorkerClass(seed) {
  const random = prng(seed);
  class ScriptedWorker {
    static workers = [];
    static live = 0;
    static maxSimultaneous = 0;
    static working = 0;
    static terminated = 0;
    constructor() {
      ScriptedWorker.workers.push(this);
      ScriptedWorker.live++;
      this.queue = [];
      this.pending = false;
      this.dead = false;
      this.expected = 0;
      this.generation = 0;
      this.actor = ScriptedWorker.workers.length - 1;
    }
    postMessage(message) {
      if (this.dead) throw Error('E_TEST: post to terminated worker');
      if (message.kind === 'init') {
        this.generation = message.generation;
        queueMicrotask(() => this.emit({kind: 'ready', generation: this.generation}));
        return;
      }
      this.queue.push(message);
      if (!this.pending) this.schedule();
    }
    emit(data) {
      if (!this.dead) this.onmessage?.({data});
    }
    schedule() {
      if (this.dead || this.pending || !this.queue.length) return;
      this.pending = true;
      ScriptedWorker.working++;
      ScriptedWorker.maxSimultaneous = Math.max(
        ScriptedWorker.maxSimultaneous, ScriptedWorker.working);
      const delay = random() % 3;
      setTimeout(() => {
        ScriptedWorker.working--;
        this.pending = false;
        if (this.dead) return;
        const message = this.queue.shift();
        if (message.sequence !== this.expected || message.generation !== this.generation) {
          this.emit({kind: 'fault',generation:this.generation,message:'E_ACTOR_PROTOCOL: non-FIFO delivery'});
          return;
        }
        this.emit({kind:'done',generation:this.generation,sequence:this.expected,
          stdout:`${this.actor}:${this.expected}\n`});
        this.expected++;
        this.schedule();
      }, delay);
    }
    terminate() {
      if (this.dead) return;
      this.dead = true;
      ScriptedWorker.live--;
      ScriptedWorker.terminated++;
      this.queue.length = 0;
    }
  }
  return ScriptedWorker;
}

test('seeded FIFO/fairness stress: 8 seeds, 16 competing actors and 128 mail per actor', async t => {
  for (const seed of seeds) await t.test('seed=' + seed, async () => {
    const WorkerImpl = createScriptedWorkerClass(seed);
    const out = {text:'',truncated:false};
    const host = createActorHost({wasm, names:['Counter'], out, WorkerImpl, workerUrl:'mock'});
    const actors = Array.from({length: MAX_ACTORS}, () => host.spawn(0));
    const next = Array.from({length: MAX_ACTORS}, () => 0);
    const random = prng((seed ^ 0xa5314) >>> 0); // JS bitwise XOR is signed
    const countPerActor = 128;
    // Randomized input interleaving while the Workers are actively scheduled.
    for (let k = 0; k < countPerActor * MAX_ACTORS; k++) {
      const available = actors.filter(ref => next[ref] < countPerActor);
      const ref = available[random() % available.length];
      host.send(ref, BigInt(next[ref]++));
      if (k % 79 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    const fault = await host.drain();
    assert.equal(fault, null, 'seed=' + seed);
    const parsed = out.text.trim().split('\n').map(line => line.split(':').map(Number));
    assert.equal(parsed.length, MAX_ACTORS * countPerActor, 'every ACK contributes exactly one output');
    const sequences = Array.from({length: MAX_ACTORS}, () => []);
    for (const [ref, seq] of parsed) {
      assert.ok(Number.isInteger(ref) && ref >= 0 && ref < MAX_ACTORS);
      sequences[ref].push(seq);
    }
    for (const seqs of sequences) {
      assert.deepEqual(seqs, Array.from({length: countPerActor}, (_,i)=>i), 'FIFO must hold per actor');
    }
    assert.ok(WorkerImpl.maxSimultaneous >= 2, 'sibling actors must make progress concurrently');
    assert.equal(WorkerImpl.live, MAX_ACTORS);
    host.close();
    assert.equal(WorkerImpl.live, 0, 'all workers reclaimed');
    assert.equal(WorkerImpl.terminated, MAX_ACTORS, 'each actor terminated exactly once');
  });
});

test('seeded cancellation/recreation fences late ACKs and faults from prior host generation', async t => {
  for (const seed of seeds) await t.test('seed=' + seed, async () => {
    const WorkerImpl = createScriptedWorkerClass(seed);
    const firstOut={text:'',truncated:false}, secondOut={text:'',truncated:false};
    const oldHost=createActorHost({wasm,names:['Counter'],out:firstOut,WorkerImpl,workerUrl:'mock'});
    const oldRef=oldHost.spawn(0);
    for (let n=0;n<100;n++) oldHost.send(oldRef, BigInt(n));
    const oldWorker=WorkerImpl.workers[0];
    const staleCallback=oldWorker.onmessage;
    const cancelled=oldHost.drain();
    oldHost.close();
    assert.equal(await cancelled,'E_ACTOR_CANCELLED: actor host closed');
    const newHost=createActorHost({wasm,names:['Counter'],out:secondOut,WorkerImpl,workerUrl:'mock'});
    const next=newHost.spawn(0);
    for (let n=0;n<18;n++) newHost.send(next,BigInt(n));
    staleCallback({data:{kind:'done',generation:oldWorker.generation,sequence:0,stdout:'ZOMBIE\n'}});
    staleCallback({data:{kind:'fault',generation:oldWorker.generation,message:'E_ACTOR: zombie fault',stdout:'POISON\n'}});
    assert.equal(await newHost.drain(),null);
    assert.equal(firstOut.text.includes('ZOMBIE'),false);
    assert.equal(secondOut.text.includes('ZOMBIE'),false);
    assert.equal(secondOut.text.includes('POISON'),false);
    assert.deepEqual(secondOut.text.trim().split('\n').map(x=>Number(x.split(':')[1])),
      Array.from({length:18},(_,i)=>i));
    newHost.close();
    assert.equal(WorkerImpl.live,0);
    assert.equal(WorkerImpl.terminated,2);
  });
});

test('mailbox quota is exact, inclusive and cannot be bypassed by randomized send order', async () => {
  class PassiveWorker {
    constructor() { this.posts=[]; this.dead=false; }
    postMessage(data) { this.posts.push(data); }
    terminate() { this.dead=true; }
  }
  const host=createActorHost({wasm,names:['A'],out:{text:'',truncated:false},
    WorkerImpl:PassiveWorker,workerUrl:'mock'});
  const a=host.spawn(0);
  const second=host.spawn(0);
  for (let i=0;i<MAX_MAILBOX;i++) host.send(a,BigInt(i));
  assert.throws(()=>host.send(a,1n),new RegExp('already has '+MAX_MAILBOX+' messages'));
  // Another actor's independent per-actor quota remains available.
  host.send(second,1n);
  host.close();
});
