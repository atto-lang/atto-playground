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
  renamed[31] = 88; // export name (7 characters), valid Wasm but wrong interface
  assert.equal(WebAssembly.validate(renamed), true);
  assert.throws(() => validateActorGuest(renamed), /export only receive/);
  assert.throws(() => validateActorGuest({}), /Invalid or oversized/);
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
