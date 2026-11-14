import test from 'node:test';
import assert from 'node:assert/strict';
import { createSymbolRegistry, MAX_SYMBOLS, MAX_SYMBOL_BYTES, actorIsolateId, SUPERVISOR_ISOLATE_ID } from '../src/symbol-registry.js';

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
  assert.equal(workerHost.symbols.get('#ready'), null);
  assert.equal(tenantHost.symbols.get('#ready'), null);
  assert.equal(workerHost.symbols.count, 0);
  assert.equal(tenantHost.symbols.count, 0);
  assert.equal(typeof workerHost.symbols.internGlobal, 'undefined', 'guests cannot mint global symbols');
  assert.equal(typeof tenantHost.symbols.internLocal, 'undefined', 'guests cannot mint private symbols');
  workerHost.close();
  tenantHost.close();
  assert.throws(() => workerHost.symbols.resolve({}, 0), /E_SYMBOL_CLOSED/);
  assert.throws(() => tenantHost.symbols.resolve({}, 0), /E_SYMBOL_CLOSED/);
});

test('supervisor isolate ID never aliases actor zero and rejects wraparound', () => {
  assert.equal(SUPERVISOR_ISOLATE_ID, 0);
  assert.equal(actorIsolateId(0), 1);
  assert.equal(actorIsolateId(1), 2);
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER, '0', null]) {
    assert.throws(() => actorIsolateId(bad), /E_SYMBOL_SCOPE/);
  }
});

test('private symbols fail cross-isolate transport; globals are copyable', () => {
  const symbols = createSymbolRegistry();
  const supervisor = SUPERVISOR_ISOLATE_ID;
  const a = actorIsolateId(0);
  const b = actorIsolateId(1);
  const global = symbols.internGlobal('app.events', '#ready');
  const privateA = symbols.internLocal(a, 'app.events', '#ready');
  assert.equal(symbols.canTransport(global, supervisor, a), true);
  assert.equal(symbols.canTransport(structuredClone(global), a, b), true);
  assert.equal(symbols.canTransport(privateA, a, b), false);
  assert.equal(symbols.canTransport(privateA, a, supervisor), false);
  assert.equal(symbols.canTransport(privateA, b, b), false);
  assert.equal(symbols.canTransport(privateA, a, a), true);
  assert.equal(symbols.canTransport({registry: symbols.registryId, id: 123456n}, a, b), false);
  assert.throws(() => symbols.canTransport(global, -1, a), /E_SYMBOL_SCOPE/);
  symbols.close();
  assert.throws(() => symbols.canTransport(global, a, b), /E_SYMBOL_CLOSED/);
});

test('unpaired UTF-16 surrogates are never accepted as a second UTF-8 spelling', () => {
  const symbols = createSymbolRegistry();
  const replacement = symbols.internGlobal('core', '#\uFFFD');
  for (const invalid of ['#\uD800', '#\uDC00', '#a\uD800b', '#\uDBFF']) {
    assert.throws(() => symbols.internGlobal('core', invalid), /E_SYMBOL_NAME/);
  }
  assert.throws(() => symbols.internGlobal('bad\uDC00', '#ready'), /E_SYMBOL_NAME/);
  assert.equal(symbols.count, 1);
  assert.equal(symbols.same(replacement, symbols.internGlobal('core', '#\uFFFD')), true);
  symbols.close();
});

test('guest static Symbol manifest is accepted only when canonical and bounded', async () => {
  const { symbolManifest, actorMailKinds } = await import('../src/guest.js');
  const leb = n => { const out = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n); return out; };
  const str = value => { const bytes = [...new TextEncoder().encode(value)]; return [...leb(bytes.length), ...bytes]; };
  const custom = (name, payload) => { const body = [...str(name), ...payload]; return [0, ...leb(body.length), ...body]; };
  const wasm = (...sections) => new WebAssembly.Module(Uint8Array.from([0,97,115,109,1,0,0,0,...sections.flat()]));
  const names = ['#ready', '#stopped'];
  const module = wasm(custom('atto.symbols', [2, ...str(names[0]), ...str(names[1])]),
                      custom('atto.actor_mail', [1,3]));
  assert.deepEqual(symbolManifest(module), names);
  assert.deepEqual(actorMailKinds(module, 1, 2), [3]);
  assert.throws(() => symbolManifest(wasm(custom('atto.symbols', [2, ...str('#ready'), ...str('#ready')]))), /E_SYMBOL_ABI/);
  assert.throws(() => symbolManifest(wasm(custom('atto.symbols', [2, ...str('#stopped'), ...str('#ready')]))), /E_SYMBOL_ABI/);
  assert.throws(() => symbolManifest(wasm(custom('atto.symbols', [1, ...str('ready')]))), /E_SYMBOL_ABI/);
  assert.throws(() => symbolManifest(wasm(custom('atto.symbols', [1, 8, 35,114]))), /E_SYMBOL_ABI/);
  assert.throws(() => actorMailKinds(wasm(custom('atto.symbols', [1, ...str('#ready')])), 1, 1), /E_SYMBOL_ABI/);
  assert.throws(() => actorMailKinds(wasm(custom('atto.actor_mail', [1,3])), 1, 0), /E_SYMBOL_ABI/);
});

test('actor host pre-interns declared globals and rejects unknown Symbol mail', async () => {
  const { createActorHost } = await import('../src/actor-host.js');
  const leb = n => { const o=[]; do {let b=n & 127;n>>>=7;if(n)b|=128;o.push(b);}while(n); return o; };
  const str = v => { const b=[...new TextEncoder().encode(v)];return [...leb(b.length), ...b]; };
  const section = (name, content) => { const b=[...str(name),...content];return [0,...leb(b.length),...b]; };
  const wasm = Uint8Array.from([0,97,115,109,1,0,0,0,
    ...section('atto.symbols',[2,...str('#ready'),...str('#stopped')]),
    ...section('atto.actor_mail',[1,3])]);
  class StubWorker { postMessage(_) {} terminate() {} }
  const host = createActorHost({ wasm, names: ['Worker'],
    out: {text:'',truncated:false}, WorkerImpl: StubWorker, workerUrl:'unused' });
  assert.equal(host.symbols.count, 2);
  const ready = host.symbols.get('#ready');
  const copied = structuredClone(ready);
  assert.equal(host.symbols.same(ready, copied), true);
  assert.equal(Object.isFrozen(host.symbols), true);
  assert.equal(typeof host.symbols.internGlobal, 'undefined');
  assert.equal(typeof host.symbols.internLocal, 'undefined');
  const worker = host.spawn(0);
  host.send(worker, 1n);
  host.send(worker, 2n);
  assert.throws(() => host.send(worker, 0n), /E_SYMBOL_UNBOUND/);
  assert.throws(() => host.send(worker, 3n), /E_SYMBOL_UNBOUND/);
  host.close();
});

test('public Symbol view refuses guessed names and private scope leakage', async () => {
  const { createPublicSymbolView } = await import('../src/symbol-registry.js');
  const registry = createSymbolRegistry();
  const names = Object.freeze(['#ready', '#stopped']);
  const view = createPublicSymbolView(registry, 'app.events', names);
  const ready = view.get('#ready');
  assert.ok(ready);
  assert.equal(view.get('#secret'), null);
  assert.equal(typeof view.internGlobal, 'undefined');
  assert.equal(typeof view.internLocal, 'undefined');
  assert.equal(view.hasGuestId(1n), true);
  assert.equal(view.hasGuestId(0n), false);
  assert.equal(view.hasGuestId(3n), false);
  assert.equal(view.hasGuestId(1), false);
  const local = registry.internLocal(1, 'app.events', '#secret');
  assert.equal(view.resolve(local, 1), null);
  assert.equal(view.canTransport(local, 1, 1), false);
  assert.equal(view.canTransport(local, 1, 2), false);
  assert.equal(view.canTransport(ready, 0, 2), true);
  assert.equal(view.same(ready, structuredClone(ready)), true);
  assert.equal(view.same(ready, local), false);
  registry.close();
});

test('public Symbol view rejects resequenced, unverified, and mutable manifests', async () => {
  const { createPublicSymbolView } = await import('../src/symbol-registry.js');
  const r = createSymbolRegistry();
  assert.throws(() => createPublicSymbolView(r, 'app', ['#ready']), /E_SYMBOL_ABI/);
  assert.throws(() => createPublicSymbolView(r, 'app', Object.freeze(['#a','#a'])), /E_SYMBOL_ABI/);
  r.close();
  const polluted = createSymbolRegistry();
  polluted.internLocal(3, 'app', '#private');
  assert.throws(() => createPublicSymbolView(polluted, 'app', Object.freeze(['#ready'])), /E_SYMBOL_ABI/);
  polluted.close();
});
