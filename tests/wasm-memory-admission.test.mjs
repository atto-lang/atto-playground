import test from 'node:test';
import assert from 'node:assert/strict';
import { admitWasm32Memory } from '../src/wasm-memory-admission.js';
import { run_tenant } from '../src/node-tenant-runner.mjs';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
function leb(v) {
  const result = [];
  do {
    let b = v & 127;
    v = Math.floor(v / 128);
    if (v) b |= 128;
    result.push(b);
  } while (v);
  return result;
}
function section(id, contents) { return [id, ...leb(contents.length), ...contents]; }
function name(s) {
  const bytes = [...new TextEncoder().encode(s)];
  return [...leb(bytes.length), ...bytes];
}
function memorySection(flags, min, max) {
  const body = [1, ...leb(flags), ...leb(min)];
  if (max !== undefined) body.push(...leb(max));
  return section(5, body);
}
function wasmMemoryOnly(flags, min, max) {
  return new Uint8Array([...header, ...memorySection(flags, min, max)]);
}
function wasmMainWithMemory(pages) {
  const type = section(1, [1, 0x60, 0, 1, 0x7e]); // () -> i64
  const func = section(3, [1, 0]);
  const memory = memorySection(1, pages, pages);
  const exports = section(7, [2, ...name('main'), 0, 0, ...name('memory'), 2, 0]);
  const code = section(10, [1, 4, 0, 0x42, 42, 0x0b]); // return i64 42
  return new Uint8Array([...header, ...type, ...func, ...memory, ...exports, ...code]);
}

test('bounded, unshared Wasm32 memories are admitted within 16 pages', () => {
  const bytecode = wasmMemoryOnly(1, 1, 16);
  assert.equal(WebAssembly.validate(bytecode), true);
  assert.equal(admitWasm32Memory(bytecode).memoryCount, 1);
  assert.equal(admitWasm32Memory(new Uint8Array(header)).memoryCount, 0);
});

test('Wasm memory admission rejects an over-quota valid guest before execution', async () => {
  const oversized = wasmMainWithMemory(17);
  assert.equal(WebAssembly.validate(oversized), true);
  assert.throws(() => admitWasm32Memory(oversized), /E_ACTOR_MEMORY: declared memory exceeds 16 pages/);
  const result = await run_tenant(oversized);
  assert.equal(result.ok, false);
  assert.match(result.message, /^E_ACTOR_MEMORY:/);
  const admitted = await run_tenant(wasmMainWithMemory(16));
  assert.equal(admitted.ok, true, admitted.message);
  assert.equal(admitted.value, '42');
});

test('Wasm32 admission rejects unbounded and shared memory and memory64', () => {
  assert.equal(WebAssembly.validate(wasmMemoryOnly(0, 1)), true);
  assert.throws(() => admitWasm32Memory(wasmMemoryOnly(0, 1)), /bounded private Wasm32/);
  assert.throws(() => admitWasm32Memory(wasmMemoryOnly(3, 1, 1)), /bounded private Wasm32/);
  assert.throws(() => admitWasm32Memory(wasmMemoryOnly(5, 1, 1)), /bounded private Wasm32/);
});

test('Wasm memory admission rejects malformed section bounds and multi-memory', () => {
  assert.throws(() => admitWasm32Memory(new Uint8Array([...header, 5, 128])), /truncated LEB32/);
  assert.throws(() => admitWasm32Memory(new Uint8Array([...header, 5, 20, 1, 1])), /malformed Wasm section bounds/);
  assert.throws(() => admitWasm32Memory(new Uint8Array([...header, ...section(5, [2])])), /multi-memory guest/);
});

test('memory-like bytes in custom sections cannot be confused with memory declarations', () => {
  const custom = section(0, [...name('test'), 5, 1, 17, 1]);
  const bytes = new Uint8Array([...header, ...custom, ...memorySection(1, 1, 16)]);
  assert.equal(WebAssembly.validate(bytes), true);
  assert.equal(admitWasm32Memory(bytes).memoryCount, 1);
});

test('Wasm import preflight rejects imported memory, other foreign resources and malformed imports', () => {
  const types = section(1, [1, 0x60, 0, 0]);
  const memoryImport = section(2, [1, ...name('env'), ...name('memory'), 2, 1, 1, 16]);
  const memoryBytes = new Uint8Array([...header, ...memoryImport]);
  assert.equal(WebAssembly.validate(memoryBytes), true);
  assert.throws(() => admitWasm32Memory(memoryBytes), /E_ACTOR_MEMORY: imported memory not admitted/);
  const allowedFn = new Uint8Array([...header, ...types,
    ...section(2, [1, ...name('atto'), ...name('print_newline'), 0, 0])]);
  assert.equal(WebAssembly.validate(allowedFn), true);
  assert.equal(admitWasm32Memory(allowedFn).memoryCount, 0);
  const globalImport = new Uint8Array([...header, ...section(2, [1, ...name('env'), ...name('g'), 3, 0x7f, 0])]);
  assert.equal(WebAssembly.validate(globalImport), true);
  assert.throws(() => admitWasm32Memory(globalImport), /non-function import/);
  assert.throws(() => admitWasm32Memory(new Uint8Array([...header, ...section(2, [1, 127])])), /malformed Wasm import bounds/);
});

test('start functions are rejected before guest instantiation', async () => {
  const type = section(1, [1, 0x60, 0, 0]);
  const func = section(3, [1, 0]);
  const start = section(8, [0]); // valid start index, no host imports needed
  const code = section(10, [1, 2, 0, 0x0b]);
  const bytes = new Uint8Array([...header, ...type, ...func, ...start, ...code]);
  assert.equal(WebAssembly.validate(bytes), true);
  assert.throws(() => admitWasm32Memory(bytes), /E_GUEST_ABI: Wasm start functions not admitted/);
  const response = await run_tenant(bytes);
  assert.equal(response.ok, false);
  assert.match(response.message, /^E_GUEST_ABI:/);
});
