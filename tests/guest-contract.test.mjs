import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { validatedGuestModule } from '../src/guest-contract.js';

const compiler = await createCompiler(await readFile(new URL('../public/atto_compiler.wasm', import.meta.url)));
const generated = compiler.compile('fnc main() -> int { return 6 * 7; }');
assert.equal(generated.ok, true);

test('real compiler output is a minimal import-free, no-memory guest', () => {
  const module = validatedGuestModule(generated.wasm);
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  assert.deepEqual(WebAssembly.Module.exports(module), [{ name: 'main', kind: 'function' }]);
  assert.equal(new WebAssembly.Instance(module, {}).exports.main(), 42);
});

test('rejects empty, oversized, bad-magic and wrong payload types', () => {
  for (const input of [null, 'wasm', new Uint8Array(), new Uint8Array(65537), new Uint8Array(8)]) {
    assert.throws(() => validatedGuestModule(input));
  }
});

test('rejects extra custom sections even if WebAssembly.validate accepts them', () => {
  const extra = Uint8Array.from([...generated.wasm, 0, 1, 0]);
  assert.equal(WebAssembly.validate(extra), true);
  assert.throws(() => validatedGuestModule(extra), /Forbidden/);
});

test('rejects hidden unexported memory and all non-M0 sections', () => {
  const memoryOnly = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 0, 1]);
  assert.equal(WebAssembly.validate(memoryOnly), true);
  assert.throws(() => validatedGuestModule(memoryOnly), /Forbidden/);
});

test('rejects structurally valid Wasm with the wrong function export', () => {
  const tampered = Uint8Array.from(generated.wasm);
  const offset = tampered.findIndex((b, i) => b === 109 && tampered[i + 1] === 97 &&
      tampered[i + 2] === 105 && tampered[i + 3] === 110);
  assert.ok(offset >= 0);
  tampered.set([101, 118, 105, 108], offset); // "main" -> "evil" (same length)
  assert.equal(WebAssembly.validate(tampered), true);
  assert.throws(() => validatedGuestModule(tampered), /export contract/);
});

test('rejects truncated or pathological section lengths before validation', () => {
  const truncated = Uint8Array.from([...generated.wasm, 0, 128]);
  assert.throws(() => validatedGuestModule(truncated), /Forbidden/);
  const broken = Uint8Array.from(generated.wasm);
  broken[9] = 255;
  assert.throws(() => validatedGuestModule(broken));
});
