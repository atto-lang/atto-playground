import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTOR_ABI, ACTOR_MAX_WASM_BYTES, I64_MIN, I64_MAX, isI64, validateActorGuest } from '../src/actor-abi.js';
import { spawnWasmActor } from '../src/actor-runtime.js';
import { COUNTER_WASM, LOOP_WASM } from './actor-fixture.mjs';

test('source-free actor ABI is valid Wasm with stateful private globals', async () => {
  assert.equal(ACTOR_ABI, 'atto.browser.actor.scalar.v0');
  assert.equal(WebAssembly.validate(COUNTER_WASM), true);
  assert.equal(WebAssembly.validate(LOOP_WASM), true);
  const m = validateActorGuest(COUNTER_WASM);
  assert.deepEqual(WebAssembly.Module.imports(m), []);
  const a = await WebAssembly.instantiate(m, {});
  const b = await WebAssembly.instantiate(m, {});
  assert.equal(a.exports.receive(40n), 40n);
  assert.equal(a.exports.receive(2n), 42n);
  assert.equal(b.exports.receive(2n), 2n, 'separate Wasm instance has private actor state');
});

test('source-free contract fails closed for wrong exports, malformed modules and overbudget modules', () => {
  assert.throws(() => validateActorGuest(new Uint8Array(0)));
  assert.throws(() => validateActorGuest(new Uint8Array(ACTOR_MAX_WASM_BYTES + 1)));
  assert.throws(() => validateActorGuest(new Uint8Array([0, 97, 115, 109])));
  const renamed = new Uint8Array(COUNTER_WASM);
  renamed[32] = 88; // first export-name byte, valid Wasm but wrong interface
  assert.equal(WebAssembly.validate(renamed), true);
  assert.throws(() => validateActorGuest(renamed), /receive function export/);
  assert.throws(() => validateActorGuest({}), /Invalid or oversized/);
});

test('actor admission verifies the real WebAssembly function signature, not just an export label', () => {
  const noParams = Uint8Array.from([
    0,97,115,109,1,0,0,0,
    1,5,1,0x60,0,1,0x7e,
    3,2,1,0,
    7,11,1,7,114,101,99,101,105,118,101,0,0,
    10,6,1,4,0,0x42,42,0x0b,
  ]);
  assert.equal(WebAssembly.validate(noParams), true);
  assert.throws(() => validateActorGuest(noParams), /receive\(i64\)->i64/);
  const wrongResult = Uint8Array.from([
    0,97,115,109,1,0,0,0,
    1,6,1,0x60,1,0x7e,1,0x7f,
    3,2,1,0,
    7,11,1,7,114,101,99,101,105,118,101,0,0,
    10,6,1,4,0,0x41,42,0x0b,
  ]);
  assert.equal(WebAssembly.validate(wrongResult), true);
  assert.throws(() => validateActorGuest(wrongResult), /receive\(i64\)->i64/);
});

test('actor payloads reject floats, JS numbers, and out-of-range i64', () => {
  assert.equal(isI64(I64_MIN), true);
  assert.equal(isI64(I64_MAX), true);
  for (const value of [1, 1.2, Number.NaN, null, true, 1n << 63n, I64_MIN - 1n]) {
    assert.equal(isI64(value), false);
  }
});

test('initialization that never responds is terminated, and resource bounds fail closed', async () => {
  let terminated = 0;
  class NeverReadyWorker {
    postMessage() {}
    terminate() { terminated++; }
  }
  await assert.rejects(spawnWasmActor(COUNTER_WASM, { WorkerImpl: NeverReadyWorker, timeoutMs: 5 }), /E_ACTOR_TIMEOUT/);
  assert.equal(terminated, 1);
  await assert.rejects(spawnWasmActor(COUNTER_WASM, { maxMailbox: 100 }), /mailbox bound/);
  await assert.rejects(spawnWasmActor(COUNTER_WASM, { timeoutMs: 0 }), /deadline/);
});


test('host fails closed on a valid but out-of-order reply ID while earlier send remains pending', async () => {
  let worker;
  class ReorderedWorker {
    constructor() { this.messages = []; this.stopped = false; worker = this; }
    postMessage(packet) {
      if (packet.kind === 'init') {
        queueMicrotask(() => this.onmessage?.({data:{kind:'ready'}}));
      } else if (packet.kind === 'message') {
        this.messages.push(packet);
        if (this.messages.length === 2) {
          const second=this.messages[1];
          // Both IDs are genuinely pending. Returning the second one first
          // must not be accepted as a valid actor result.
          queueMicrotask(() => this.onmessage?.({data:{
            kind:'result',id:second.id,value:second.value
          }}));
        }
      }
    }
    terminate() { this.stopped = true; }
  }
  const actor = await spawnWasmActor(COUNTER_WASM,{WorkerImpl:ReorderedWorker});
  const first=actor.send(40n);
  const second=actor.send(2n);
  const settled=await Promise.allSettled([first,second]);
  assert.equal(settled.length,2);
  for (const value of settled) {
    assert.equal(value.status,'rejected');
    assert.match(value.reason.message,/E_ACTOR_PROTOCOL: out-of-order/);
  }
  assert.equal(worker.stopped,true);
  assert.equal(actor.closed,true);
});

test('host kills actor on duplicated reply for an already settled request', async () => {
  let worker;
  class DuplicateReplyWorker {
    constructor() { this.stopped=false; worker=this; }
    postMessage(packet) {
      if (packet.kind==='init') queueMicrotask(() => this.onmessage?.({data:{kind:'ready'}}));
      if (packet.kind==='message') queueMicrotask(() => {
        this.onmessage?.({data:{kind:'result',id:packet.id,value:packet.value}});
        this.onmessage?.({data:{kind:'result',id:packet.id,value:packet.value}});
      });
    }
    terminate() { this.stopped=true; }
  }
  const actor=await spawnWasmActor(COUNTER_WASM,{WorkerImpl:DuplicateReplyWorker});
  assert.equal(await actor.send(42n),42n);
  assert.equal(actor.closed,true);
  assert.equal(worker.stopped,true);
  await assert.rejects(actor.send(1n),/E_ACTOR_CLOSED/);
});

test('bounded admission refuses excess sends without allocating sequence IDs and close rejects all pending work', async () => {
  let worker;
  class StalledWorker {
    constructor() { this.messages = []; this.terminations = 0; worker = this; }
    postMessage(packet) {
      if (packet.kind === 'init') queueMicrotask(() => this.onmessage?.({data:{kind:'ready'}}));
      if (packet.kind === 'message') this.messages.push(packet);
    }
    terminate() { this.terminations++; }
  }
  const actor = await spawnWasmActor(COUNTER_WASM, {WorkerImpl: StalledWorker, maxMailbox: 2, timeoutMs: 500});
  const first = actor.send(40n);
  const second = actor.send(2n);
  await assert.rejects(actor.send(1n), /E_MAILBOX_FULL/);
  assert.deepEqual(worker.messages.map(m => m.id), [1, 2],
    'rejected admission must not enter mailbox or consume an ID');
  actor.close();
  const settled = await Promise.allSettled([first, second]);
  for (const result of settled) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /E_ACTOR_CLOSED/);
  }
  await assert.rejects(actor.send(3n), /E_ACTOR_CLOSED/);
  actor.close();
  assert.equal(worker.terminations, 1, 'repeated close must never double-terminate');
});

test('actor init copies caller-owned compiler guest bytes, never transfers or aliases them', async () => {
  const guest = new Uint8Array(COUNTER_WASM);
  const snapshot = new Uint8Array(guest);
  let initBytes;
  class CaptureWorker {
    postMessage(packet) {
      if (packet.kind === 'init') {
        initBytes = packet.wasm;
        queueMicrotask(() => this.onmessage?.({data:{kind:'ready'}}));
      }
    }
    terminate() {}
  }
  const actor = await spawnWasmActor(guest, {WorkerImpl: CaptureWorker});
  assert.ok(initBytes instanceof Uint8Array);
  assert.notStrictEqual(initBytes, guest);
  assert.notStrictEqual(initBytes.buffer, guest.buffer);
  guest.fill(0);
  assert.deepEqual(initBytes, snapshot, 'guest mutation after spawn cannot corrupt worker-owned bytes');
  actor.close();
});

test('premature worker result rejects initialization and terminally destroys worker', async () => {
  let terminated = 0;
  class PrematureWorker {
    postMessage(packet) {
      if (packet.kind === 'init') queueMicrotask(() =>
        this.onmessage?.({data:{kind:'result',id:1,value:1n}}));
    }
    terminate() { terminated++; }
  }
  await assert.rejects(spawnWasmActor(COUNTER_WASM, {WorkerImpl: PrematureWorker}),
    /E_ACTOR_PROTOCOL: invalid worker response/);
  assert.equal(terminated, 1);
});

test('duplicate ready is a terminal protocol violation, not actor reinitialization', async () => {
  let terminated = 0;
  class DoubleReadyWorker {
    postMessage(packet) {
      if (packet.kind === 'init') queueMicrotask(() => {
        this.onmessage?.({data:{kind:'ready'}});
        this.onmessage?.({data:{kind:'ready'}});
      });
    }
    terminate() { terminated++; }
  }
  const actor = await spawnWasmActor(COUNTER_WASM, {WorkerImpl: DoubleReadyWorker});
  assert.equal(actor.closed, true);
  assert.equal(terminated, 1);
  await assert.rejects(actor.send(1n), /E_ACTOR_CLOSED/);
});

test('guest panic notice rejects every outstanding send and prevents further mailbox admission', async () => {
  let worker;
  class PanicWorker {
    constructor() { this.messages = []; this.terminated = false; worker = this; }
    postMessage(packet) {
      if (packet.kind === 'init') queueMicrotask(() => this.onmessage?.({data:{kind:'ready'}}));
      if (packet.kind === 'message') {
        this.messages.push(packet);
        if (this.messages.length === 2) queueMicrotask(() =>
          this.onmessage?.({data:{kind:'fault',message:'E_ACTOR_PANIC: checked integer overflow'}}));
      }
    }
    terminate() { this.terminated = true; }
  }
  const actor = await spawnWasmActor(COUNTER_WASM, {WorkerImpl: PanicWorker, timeoutMs: 500});
  const settled = await Promise.allSettled([actor.send(1n), actor.send(2n)]);
  assert.deepEqual(worker.messages.map(m => m.id), [1, 2]);
  for (const result of settled) {
    assert.equal(result.status, 'rejected');
    assert.match(result.reason.message, /E_ACTOR_PANIC: checked integer overflow/);
  }
  assert.equal(actor.closed, true);
  assert.equal(worker.terminated, true);
  await assert.rejects(actor.send(3n), /E_ACTOR_CLOSED/);
});
