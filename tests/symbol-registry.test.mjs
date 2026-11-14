import test from 'node:test';
import assert from 'node:assert/strict';
import { createSymbolRegistry, MAX_SYMBOLS, MAX_SYMBOL_BYTES } from '../src/symbol-registry.js';

test('supervisor and actor contexts resolve one exported global identity', () => {
  const registry = createSymbolRegistry();
  const supervisor = registry.internGlobal('app.events', '#ready');
  const actorOne = registry.internGlobal('app.events', '#ready');
  const actorTwo = structuredClone(registry.globalManifest()[0].handle);
  assert.strictEqual(supervisor, actorOne, 'one host canonical handle');
  assert.notStrictEqual(supervisor, actorTwo, 'postMessage copies the handle');
  assert.equal(registry.same(supervisor, actorTwo), true, 'logical identity survives worker cloning');
  for (const actorId of [0, 1, 2, 2048]) {
    assert.deepEqual(registry.resolve(actorTwo, actorId), {
      scope: 'global', module: 'app.events', name: '#ready',
    });
  }
  assert.equal(registry.count, 1);
  registry.close();
});

test('unexported symbols remain actor/isolate-local; shared text is not shared identity', () => {
  const registry = createSymbolRegistry();
  const supervisor = registry.internLocal(0, 'app.events', '#ready');
  const a = registry.internLocal(1, 'app.events', '#ready');
  const b = registry.internLocal(2, 'app.events', '#ready');
  assert.equal(registry.same(a, registry.internLocal(1, 'app.events', '#ready')), true);
  assert.equal(registry.same(a, b), false);
  assert.equal(registry.same(a, supervisor), false);
  assert.equal(registry.resolve(a, 0), null, 'supervisor cannot dereference actor private symbol');
  assert.equal(registry.resolve(a, 2), null, 'sibling cannot dereference actor private symbol');
  assert.deepEqual(registry.resolve(structuredClone(a), 1), {
    scope: 'local', module: 'app.events', name: '#ready',
  });
  assert.deepEqual(registry.globalManifest(), [], 'private symbols never enter manifest');
  registry.close();
});

test('fully qualified names and exact Unicode distinguish identities', () => {
  const symbols = createSymbolRegistry();
  const a = symbols.internGlobal('app.a', '#with spaces');
  const b = symbols.internGlobal('app.b', '#with spaces');
  const c = symbols.internGlobal('app.a', '#with  spaces');
  const d = symbols.internGlobal('app.a', '#café');
  const e = symbols.internGlobal('app.a', '#cafe\u0301');
  assert.equal(symbols.same(a, b), false);
  assert.equal(symbols.same(a, c), false);
  assert.equal(symbols.same(d, e), false, 'no implicit Unicode normalization');
  assert.equal(symbols.count, 5);
  symbols.close();
});

test('canonical keys cannot collide through punctuation and owner substitutions', () => {
  const symbols = createSymbolRegistry();
  const a = symbols.internGlobal('a,b', '#c,d');
  const b = symbols.internGlobal('a', '#b,c,d');
  const c = symbols.internLocal(1, 'a,b', '#c,d');
  assert.equal(symbols.same(a, b), false);
  assert.equal(symbols.same(a, c), false);
  assert.equal(symbols.internLocal(1, 'a,b', '#c,d'), c);
  symbols.close();
});

test('forged, foreign, stale and malformed handles cannot resolve', () => {
  const a = createSymbolRegistry();
  const b = createSymbolRegistry();
  const handle = a.internGlobal('core', '#panic');
  assert.equal(b.same(handle, b.internGlobal('core', '#panic')), false);
  assert.equal(b.resolve(handle, 0), null);
  assert.equal(a.resolve({ registry: handle.registry, id: 9999n }, 0), null);
  assert.equal(a.resolve({ registry: handle.registry, id: Number(handle.id) }, 0), null);
  assert.equal(a.resolve({ registry: 'not-the-tenant', id: handle.id }, 0), null);
  assert.equal(a.same(handle, Object.freeze({ ...handle, id: handle.id + 1n })), false);
  a.close();
  assert.equal(a.same(handle, handle), false);
  assert.throws(() => a.resolve(handle, 0), /E_SYMBOL_CLOSED/);
  assert.throws(() => a.internGlobal('core', '#panic'), /E_SYMBOL_CLOSED/);
  b.close();
});

test('bounded, fail-closed allocation without resetting already published identity', () => {
  const symbols = createSymbolRegistry({ maxSymbols: 2, maxBytes: 28 });
  const first = symbols.internGlobal('m', '#a');
  assert.equal(symbols.internGlobal('m', '#a'), first);
  symbols.internGlobal('m', '#b');
  assert.throws(() => symbols.internGlobal('m', '#c'), /E_SYMBOL_LIMIT/);
  assert.equal(symbols.count, 2);
  assert.equal(symbols.same(first, symbols.internGlobal('m', '#a')), true);
  symbols.close();

  const bytes = createSymbolRegistry({ maxBytes: 4 });
  bytes.internGlobal('m', '#a'); // 3 bytes
  assert.throws(() => bytes.internGlobal('m', '#b'), /E_SYMBOL_LIMIT/);
  assert.equal(bytes.bytes, 3);
  bytes.close();
});

test('invalid namespaces, owners, names and registry limits fail closed', () => {
  const symbols = createSymbolRegistry();
  for (const invalid of ['', 'ready', '#', '#bad\nname', '#\0']) {
    assert.throws(() => symbols.internGlobal('app', invalid), /E_SYMBOL_NAME/);
  }
  for (const invalid of ['', 'bad\nmodule', 12]) {
    assert.throws(() => symbols.internGlobal(invalid, '#ready'), /E_SYMBOL_NAME/);
  }
  for (const invalid of [-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => symbols.internLocal(invalid, 'app', '#ready'), /E_SYMBOL_SCOPE/);
  }
  assert.throws(() => symbols.internGlobal('m', '#x'.repeat(3000)), /E_SYMBOL_LIMIT/);
  assert.equal(symbols.count, 0);
  assert.throws(() => createSymbolRegistry({ maxSymbols: MAX_SYMBOLS + 1 }), /E_SYMBOL_LIMIT/);
  assert.throws(() => createSymbolRegistry({ maxBytes: MAX_SYMBOL_BYTES + 1 }), /E_SYMBOL_LIMIT/);
  symbols.close();
});

test('both actor host lifecycles own independent registries and invalidate them at close', async () => {
  const { createActorHost } = await import('../src/actor-host.js');
  const { createTenantActorHost } = await import('../src/tenant-actor-host.js');
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); // valid empty module
  const out = { text: '', truncated: false };
  const workerHost = createActorHost({ wasm, names: ['A'], out });
  const tenantHost = createTenantActorHost({
    module: new WebAssembly.Module(wasm), names: ['A'], out,
  });
  const workerReady = workerHost.symbols.internGlobal('events', '#ready');
  const tenantReady = tenantHost.symbols.internGlobal('events', '#ready');
  assert.equal(workerHost.symbols.same(workerReady, workerReady), true);
  assert.equal(workerHost.symbols.same(workerReady, tenantReady), false);
  assert.equal(tenantHost.symbols.resolve(workerReady, 0), null);
  workerHost.close();
  tenantHost.close();
  assert.throws(() => workerHost.symbols.internGlobal('events', '#more'), /E_SYMBOL_CLOSED/);
  assert.throws(() => tenantHost.symbols.internGlobal('events', '#more'), /E_SYMBOL_CLOSED/);
});
