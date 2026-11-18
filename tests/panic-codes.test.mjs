import test from 'node:test';
import assert from 'node:assert/strict';
import { describePanic } from '../src/guest.js';

const at = code => ({ exports: { panic_code: { value: code } } });
const trap = new WebAssembly.RuntimeError('unreachable');

test('every guest ABI panic code has a specific message', () => {
  assert.match(describePanic(at(1), trap), /integer overflow/);
  assert.match(describePanic(at(3), trap), /heap exhausted/);
  assert.match(describePanic(at(4), trap), /generator handle/);
  assert.match(describePanic(at(5), trap), /generator step budget/);
  assert.match(describePanic(at(6), trap), /^E_PANIC: stack overflow/);
});

test('the compiler stack quota is reported before the engine RangeError fallback', () => {
  // panic 6 is a deterministic trap; an engine RangeError without a code is
  // the legacy, engine-dependent path for compilers without the quota.
  assert.match(describePanic(at(6), new RangeError('Maximum call stack size exceeded')), /1024 nested recursive calls/);
  assert.match(describePanic(at(0), new RangeError('Maximum call stack size exceeded')), /stack exhausted/);
});
