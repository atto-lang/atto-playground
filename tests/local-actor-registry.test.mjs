import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalActorRegistry } from '../src/local-actor-registry.js';
import { createActorHost } from '../src/actor-host.js';

const key = (application_key, namespace = 'tenant-a', actor_type = 0) =>
  ({ namespace, actor_type, application_key });

function fixture(names = ['Queue', 'Counter']) {
  const slots = [];
  let creates = 0;
  let failSpawn = false;
  const deliveries = [];
  const host = {
    names,
    spawn(type) {
      if (failSpawn) throw new Error('synthetic activation failure');
      const slot = slots.length;
      slots.push({ type, alive: true });
      creates++;
      return slot;
    },
    isLive(slot) { return !!slots[slot]?.alive; },
    retire(slot) { if (!slots[slot]?.alive) return false; slots[slot].alive = false; return true; },
    send(slot, value) {
      if (!slots[slot]?.alive) throw new Error('E_ACTOR_DEAD');
      deliveries.push([slot, value]);
    }
  };
  const registry = createLocalActorRegistry(host);
  return { registry, slots, deliveries, get creates() { return creates; },
    set failSpawn(v) { failSpawn = v; } };
}

test('virtual ref and lookup never activate an undeclared or absent entity', () => {
  const f = fixture();
  const v = f.registry.ref_for(key('orders'));
  assert.equal(v.kind, 'VirtualActorRef');
  assert.equal(f.registry.lookup(v), null);
  assert.equal(f.registry.lookup(key('orders')), null);
  assert.equal(f.creates, 0);
});

test('concurrent same-key lookups publish only one local activation', async () => {
  const f = fixture();
  const refs = await Promise.all(Array.from({ length: 64 }, () =>
    Promise.resolve().then(() => f.registry.get_or_create(key('payments')))));
  assert.equal(new Set(refs).size, 1);
  assert.equal(f.creates, 1);
  assert.equal(f.registry.size, 1);
});

test('key namespaces, actor types and boundaries cannot alias', () => {
  const f = fixture();
  const refs = [
    f.registry.get_or_create(key('a:b', 'x', 0)),
    f.registry.get_or_create(key('b', 'x:a', 0)),
    f.registry.get_or_create(key('a:b', 'x', 1)),
    f.registry.get_or_create(key('a:b', 'other', 0)),
    f.registry.get_or_create(key('a\u0000b', 'x', 0))
  ];
  assert.equal(new Set(refs).size, 5);
  assert.equal(f.creates, 5);
  for (const ref of refs) assert.equal(f.registry.lookup(ref), ref);
});

test('malformed, oversized or noncanonical Unicode keys are rejected', () => {
  const f = fixture();
  for (const bad of [key(''), key('x', ''), key('x', 'a', -1), key('x', 'a', 2),
    key('x'.repeat(4097)), key('\ud800'), key('\udc00'), null]) {
    assert.throws(() => f.registry.get_or_create(bad), /E_ACTOR_KEY/);
  }
  assert.equal(f.creates, 0);
});

test('only creator gets registration token, token is exact and cannot be forged', () => {
  const f = fixture();
  const first = f.registry.register(key('q'));
  assert.equal(first.created, true);
  assert.equal(f.registry.register(key('q')).token, null);
  assert.equal(f.registry.unregister(key('q'), {}), false);
  assert.equal(f.registry.unregister(key('q'), null), false);
  assert.equal(f.registry.lookup(key('q')), first.ref);
  assert.equal(f.registry.unregister(key('q'), first.token), true);
  assert.equal(f.registry.lookup(key('q')), null);
  assert.equal(f.slots[0].alive, false);
});

test('stale removal cannot erase an unrelated successor; incarnations never repeat', () => {
  const f = fixture();
  const a = f.registry.register(key('q'));
  assert.equal(f.registry.unregister(key('q'), a.token), true);
  const b = f.registry.register(key('q'));
  assert.notEqual(a.ref, b.ref);
  assert.ok(b.ref.incarnation > a.ref.incarnation);
  assert.equal(f.registry.unregister(key('q'), a.token), false);
  assert.equal(f.registry.lookup(key('q')), b.ref);
  assert.throws(() => f.registry.send(a.ref, 1n), /E_ACTOR_REF_STALE/);
  f.registry.send(b.ref, 2n);
  assert.deepEqual(f.deliveries, [[1, 2n]]);
});

test('failed activation never strands key and permits a subsequent attempt', () => {
  const f = fixture();
  f.failSpawn = true;
  assert.throws(() => f.registry.get_or_create(key('q')), /synthetic/);
  f.failSpawn = false;
  assert.equal(f.registry.get_or_create(key('q')).kind, 'ActorRef');
  assert.equal(f.creates, 1);
});

test('same-key recursive activation fails fast instead of deadlocking', () => {
  let registry;
  let calls = 0;
  registry = createLocalActorRegistry({
    names: ['A'],
    spawn() {
      calls++;
      assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_RECURSIVE/);
      return 0;
    },
    send() {},
    isLive() { return true; },
    retire() {}
  });
  assert.equal(registry.get_or_create(key('q')).kind, 'ActorRef');
  assert.equal(calls, 1);
});

test('unrelated key activation does not block the same synchronous registry', () => {
  let registry;
  const slots = [];
  registry = createLocalActorRegistry({
    names: ['A'],
    spawn() {
      const slot = slots.length;
      slots.push(true);
      if (slot === 0) assert.equal(registry.get_or_create(key('other')).kind, 'ActorRef');
      return slot;
    },
    send() {},
    isLive(slot) { return slots[slot]; },
    retire(slot) { slots[slot] = false; }
  });
  registry.get_or_create(key('first'));
  assert.equal(registry.size, 2);
});

test('host actor death allows reactivation, never revival of a physical ref', () => {
  const f = fixture();
  const old = f.registry.get_or_create(key('q'));
  f.slots[0].alive = false;
  assert.equal(f.registry.lookup(key('q')), null);
  const newer = f.registry.get_or_create(key('q'));
  assert.notEqual(old, newer);
  assert.equal(f.creates, 2);
  assert.throws(() => f.registry.send(old, 1n), /E_ACTOR_REF_STALE/);
  f.registry.send(newer, 2n);
  assert.deepEqual(f.deliveries, [[1, 2n]]);
});

test('forged and cross-registry physical refs cannot send or retire actors', () => {
  const a = fixture(), b = fixture();
  const ref = a.registry.get_or_create(key('q'));
  const foreign = b.registry.get_or_create(key('q'));
  assert.throws(() => a.registry.send(foreign, 1n), /E_ACTOR_REF_STALE/);
  assert.throws(() => a.registry.send({ ...ref }, 1n), /E_ACTOR_REF_STALE/);
  assert.throws(() => a.registry.send(0, 1n), /E_ACTOR_REF_STALE/);
  a.registry.send(ref, 3n);
  assert.deepEqual(a.deliveries, [[0, 3n]]);
});

test('closing registry invalidates all physical refs and blocks activation', () => {
  const f = fixture();
  const ref = f.registry.get_or_create(key('q'));
  f.registry.close();
  f.registry.close();
  assert.equal(f.registry.size, 0);
  assert.throws(() => f.registry.lookup(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
  assert.throws(() => f.registry.send(ref, 1n), /E_ACTOR_REGISTRY_CLOSED/);
  assert.throws(() => f.registry.register(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
});

test('real actor host routes keyed sends through its bounded FIFO worker protocol', async () => {
  const workers = [];
  class TestWorker {
    constructor() { this.alive = true; this.messages = []; workers.push(this); }
    postMessage(data) {
      if (data.kind === 'init') {
        queueMicrotask(() => { if (this.alive) this.onmessage?.({ data: { kind: 'ready' } }); });
      } else {
        this.messages.push(data.value);
        queueMicrotask(() => {
          if (this.alive) this.onmessage?.({ data: { kind: 'done', sequence: data.sequence } });
        });
      }
    }
    terminate() { this.alive = false; }
  }
  const host = createActorHost({
    wasm: new Uint8Array([0,97,115,109,1,0,0,0]),
    names: ['Queue'], out: { text: '', truncated: false },
    WorkerImpl: TestWorker, workerUrl: 'fake-worker.js'
  });
  const v = host.registry.ref_for(key('q'));
  assert.equal(host.count, 0);
  assert.equal(host.registry.lookup(v), null);
  const a = host.registry.register(v);
  assert.equal(host.registry.get_or_create(v), a.ref);
  host.registry.send(a.ref, 10n);
  host.registry.send(a.ref, 11n);
  assert.equal(await host.drain(), null);
  assert.equal(host.count, 1);
  assert.deepEqual(workers[0].messages, [10n, 11n]);
  assert.equal(host.registry.unregister(v, a.token), true);
  assert.equal(workers[0].alive, false);
  assert.throws(() => host.registry.send(a.ref, 12n), /E_ACTOR_REF_STALE/);
  host.close();
  assert.throws(() => host.registry.get_or_create(v), /E_ACTOR_REGISTRY_CLOSED/);
});
