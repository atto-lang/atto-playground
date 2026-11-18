import test from 'node:test';
import assert from 'node:assert/strict';
import { admitWasm32Memory } from '../src/wasm-memory-admission.js';

const header = [0, 97, 115, 109, 1, 0, 0, 0];
function leb(value) {
  const bytes = [];
  do {
    let byte = value & 127;
    value = Math.floor(value / 128);
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return bytes;
}
function moduleWithMemory(minimum, maximum) {
  const contents = [1, 1, ...leb(minimum), ...leb(maximum)];
  return new Uint8Array([...header, 5, ...leb(contents.length), ...contents]);
}

test('admission returns exact declared min/max while preserving policy quota', () => {
  const bytes = moduleWithMemory(2, 16);
  assert.equal(WebAssembly.validate(bytes), true);
  assert.deepEqual(admitWasm32Memory(bytes), {
    memoryCount: 1, maxPages: 16, minimumPages: 2, maximumPages: 16
  });
  assert.deepEqual(admitWasm32Memory(new Uint8Array(header)), {
    memoryCount: 0, maxPages: 16, minimumPages: 0, maximumPages: 0
  });
});

test('custom policy restricts the same guest without conflating declaration and quota', () => {
  const bytes = moduleWithMemory(1, 8);
  assert.deepEqual(admitWasm32Memory(bytes, { maxPages: 9 }), {
    memoryCount: 1, maxPages: 9, minimumPages: 1, maximumPages: 8
  });
  assert.throws(() => admitWasm32Memory(bytes, { maxPages: 7 }), /exceeds 7 pages/);
  assert.throws(() => admitWasm32Memory(moduleWithMemory(8, 7)), /declared memory exceeds/);
});
