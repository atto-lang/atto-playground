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

test('shutdown during spawn cancels publication and retires the provisional actor', () => {
  let registry;
  let retired = 0;
  let live = true;
  registry = createLocalActorRegistry({
    names: ['Queue'],
    spawn() { registry.close(); return 0; },
    send() { assert.fail('no delivery after shutdown'); },
    isLive() { return live; },
    retire(slot) { assert.equal(slot, 0); retired++; live = false; return true; }
  });
  assert.throws(() => registry.register(key('race')), /E_ACTOR_REGISTRY_CLOSED/);
  assert.equal(retired, 1, 'rolled back actor exactly once');
  assert.equal(live, false);
  assert.equal(registry.size, 0);
});

test('shutdown during a liveness callback cannot publish the activation', () => {
  let registry, retired = 0, live = true;
  registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() {},
    isLive() { if (live) registry.close(); return live; },
    retire() { retired++; live = false; return true; }
  });
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
  assert.equal(retired, 1);
  assert.equal(registry.size, 0);
});

test('liveness exceptions roll back allocation and permit a fresh attempt', () => {
  let slot = 0, retired = 0, throwOnce = true;
  const dead = new Set();
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return slot++; },
    send() {},
    isLive(id) {
      if (throwOnce) { throwOnce = false; throw new Error('synthetic liveness error'); }
      return !dead.has(id);
    },
    retire(id) { retired++; dead.add(id); return true; }
  });
  assert.throws(() => registry.get_or_create(key('q')), /synthetic liveness/);
  assert.equal(retired, 1);
  const ref = registry.get_or_create(key('q'));
  assert.equal(ref.incarnation, 1n);
  assert.equal(registry.size, 1);
});

test('failed rollback quarantines registry instead of permitting duplicate owners', () => {
  let registry;
  registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { registry.close(); return 0; },
    send() {}, isLive() { return true; },
    retire() { throw new Error('cannot stop actor'); }
  });
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_ROLLBACK/);
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
});

test('failed retirement quarantines registry and invalidates physical ref', () => {
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() { assert.fail('must not deliver after uncertain retirement'); },
    isLive() { return true; },
    retire() { throw new Error('cannot retire'); }
  });
  const registration = registry.register(key('q'));
  assert.throws(() => registry.unregister(key('q'), registration.token), /E_ACTOR_REGISTRY_RETIRE_FAILED/);
  assert.equal(registry.size, 0);
  assert.throws(() => registry.send(registration.ref, 3n), /E_ACTOR_REGISTRY_CLOSED/);
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
});

test('physical slot reuse for another key fails closed without retiring its owner', () => {
  let retired = 0;
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() {}, isLive() { return true; },
    retire() { retired++; return true; }
  });
  const owner = registry.get_or_create(key('first'));
  assert.throws(() => registry.get_or_create(key('second')), /E_ACTOR_REGISTRY_SLOT_REUSE/);
  assert.equal(registry.lookup(key('first')), owner);
  assert.equal(registry.lookup(key('second')), null);
  assert.equal(retired, 0);
});

test('slot reuse is prohibited even after retirement within the same registry epoch', () => {
  let live = true;
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() {}, isLive() { return live; }, retire() { live = false; return true; }
  });
  const first = registry.register(key('q'));
  assert.equal(registry.unregister(key('q'), first.token), true);
  assert.throws(() => registry.register(key('q')), /E_ACTOR_REGISTRY_SLOT_REUSE/);
});

test('actor name table is snapshotted, never mutable by registry callers', () => {
  const names = ['Queue'];
  const f = fixture(names);
  names[0] = 'Z';
  assert.throws(() => f.registry.ref_for(key('x'.repeat(4091), 'n')), /E_ACTOR_KEY/);
  assert.equal(f.creates, 0);
});

test('mass key churn has globally unique generations without retaining per-key tombstones', () => {
  const f = fixture();
  let last = 0n;
  for (let i = 0; i < 512; i++) {
    const registration = f.registry.register(key('queue-' + i));
    assert.ok(registration.ref.incarnation > last);
    last = registration.ref.incarnation;
    assert.equal(f.registry.unregister(key('queue-' + i), registration.token), true);
  }
  assert.equal(f.registry.size, 0);
  assert.equal(f.creates, 512);
  assert.equal(f.registry.get_or_create(key('queue-0')).incarnation, 513n);
});

test('strict Unicode key identity preserves distinct code point sequences', () => {
  const f = fixture();
  const nfc = f.registry.get_or_create(key('caf\u00e9'));
  const nfd = f.registry.get_or_create(key('cafe\u0301'));
  assert.notEqual(nfc, nfd, 'normalization is never implicit');
  assert.equal(f.registry.lookup(key('caf\u00e9')), nfc);
  assert.equal(f.registry.lookup(key('cafe\u0301')), nfd);
});

test('virtual refs are snapshots, and cloned physical refs are not capabilities', () => {
  const f = fixture();
  const mutable = key('orders');
  const v = f.registry.ref_for(mutable);
  mutable.application_key = 'payments';
  assert.equal(v.key.application_key, 'orders');
  const p = f.registry.get_or_create(v);
  assert.throws(() => f.registry.send(structuredClone(p), 1n), /E_ACTOR_REF_STALE/);
  f.registry.send(p, 2n);
  assert.deepEqual(f.deliveries, [[0, 2n]]);
});

test('unsupported async activation callback fails without a published mapping', () => {
  const registry = createLocalActorRegistry({
    names: ['Queue'],
    spawn() { return Promise.resolve(0); },
    send() {}, isLive() { return true; }, retire() {}
  });
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_DEAD/);
  assert.equal(registry.size, 0);
});

test('worker creation failure releases Worker and does not consume an actor slot', () => {
  const workers = [];
  class FailingWorker {
    constructor() { this.dead = false; workers.push(this); }
    postMessage() {
      if (workers.length === 1) throw new Error('synthetic structured clone failure');
    }
    terminate() { this.dead = true; }
  }
  const host = createActorHost({
    wasm: new Uint8Array([0,97,115,109,1,0,0,0]),
    names: ['Queue'], out: { text: '', truncated: false },
    WorkerImpl: FailingWorker, workerUrl: 'fake-worker.js'
  });
  assert.throws(() => host.registry.get_or_create(key('q')), /synthetic structured clone/);
  assert.equal(host.count, 0);
  assert.equal(workers[0].dead, true);
  assert.equal(host.registry.get_or_create(key('q')).kind, 'ActorRef');
  assert.equal(host.count, 1);
  host.close();
  assert.equal(workers[1].dead, true);
});

test('lookup refuses a reference if its liveness callback closes registry', () => {
  let registry, inspecting = false;
  registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; }, send() {}, retire() {},
    isLive() {
      if (inspecting) registry.close();
      return true;
    }
  });
  registry.get_or_create(key('q'));
  inspecting = true;
  assert.throws(() => registry.lookup(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
});

test('existing registration is revalidated after a callback retires it', () => {
  let registry, active = false, nextSlot = 0, token = null, oldRef = null;
  const alive = new Set();
  registry = createLocalActorRegistry({
    names: ['Queue'],
    spawn() { const slot = nextSlot++; alive.add(slot); return slot; },
    send() {},
    retire(slot) { alive.delete(slot); return true; },
    isLive(slot) {
      if (active && slot === 0) {
        active = false;
        assert.equal(registry.unregister(key('q'), token), true);
        return true; // stale observation must be rejected.
      }
      return alive.has(slot);
    }
  });
  const first = registry.register(key('q'));
  token = first.token;
  oldRef = first.ref;
  active = true;
  const newer = registry.get_or_create(key('q'));
  assert.notEqual(newer, oldRef);
  assert.equal(newer.incarnation, 2n);
  assert.equal(registry.lookup(key('q')), newer);
});

test('send never admits mail after callback-driven retirement', () => {
  let registry, retireDuringCheck = false, token;
  const deliveries = [];
  let alive = true;
  registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send(_slot, payload) { deliveries.push(payload); },
    retire() { alive = false; return true; },
    isLive() {
      if (retireDuringCheck) {
        retireDuringCheck = false;
        assert.equal(registry.unregister(key('q'), token), true);
        return true; // deliberately stale callback observation
      }
      return alive;
    }
  });
  const reg = registry.register(key('q'));
  token = reg.token;
  retireDuringCheck = true;
  assert.throws(() => registry.send(reg.ref, 42n), /E_ACTOR_REF_STALE/);
  assert.deepEqual(deliveries, []);
});

test('send rejects a reentrant close before host mailbox admission', () => {
  let registry, closing = false;
  const delivered = [];
  registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send(_slot, value) { delivered.push(value); },
    retire() {},
    isLive() { if (closing) registry.close(); return true; }
  });
  const ref = registry.get_or_create(key('q'));
  closing = true;
  assert.throws(() => registry.send(ref, 1n), /E_ACTOR_REGISTRY_CLOSED/);
  assert.deepEqual(delivered, []);
});

test('retirement that returns false but leaves actor alive quarantines registry', () => {
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() {}, isLive() { return true; },
    retire() { return false; } // malicious/buggy host callback
  });
  const registration = registry.register(key('q'));
  assert.throws(() => registry.unregister(key('q'), registration.token), /E_ACTOR_REGISTRY_RETIRE_FAILED/);
  assert.equal(registry.size, 0);
  assert.throws(() => registry.register(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
});

test('rollback that leaves a provisional actor alive quarantines registry', () => {
  let registry;
  registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { registry.close(); return 0; },
    send() {}, isLive() { return true; },
    retire() { return true; } // claims success but remains live
  });
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_ROLLBACK/);
  assert.throws(() => registry.get_or_create(key('other')), /E_ACTOR_REGISTRY_CLOSED/);
});

test('already-dead actor can be removed even if retirement returns false', () => {
  let live = true;
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() {}, isLive() { return live; },
    retire() { return false; }
  });
  const registration = registry.register(key('q'));
  live = false;
  assert.equal(registry.unregister(key('q'), registration.token), true);
  assert.equal(registry.size, 0);
  assert.equal(registry.lookup(key('q')), null);
});

test('retirement liveness probe throwing quarantines instead of permitting reactivation', () => {
  let count = 0;
  const registry = createLocalActorRegistry({
    names: ['Queue'], spawn() { return 0; },
    send() {}, isLive() {
      if (++count > 1) throw new Error('liveness indeterminate');
      return true;
    }, retire() { return true; }
  });
  const registration = registry.register(key('q'));
  assert.throws(() => registry.unregister(key('q'), registration.token), /E_ACTOR_REGISTRY_RETIRE_FAILED/);
  assert.throws(() => registry.get_or_create(key('q')), /E_ACTOR_REGISTRY_CLOSED/);
});
