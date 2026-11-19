// Actor host bookkeeping with the real compiler and real guest instances.
// FakeWorker follows src/actor-worker.js's protocol in-process; the actual
// worker file runs in Chromium in tests/browser-e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames, describePanic, guestImports } from '../src/guest.js';
import { createActorHost, MAX_ACTORS, MAX_MAILBOX } from '../src/actor-host.js';

const compiler = await createCompiler(await readFile(new URL('../public/atto_compiler.wasm', import.meta.url)));

class FakeWorker {
  static live = 0;
  constructor() { FakeWorker.live++; this.queue = Promise.resolve(); this.out = { text: '', truncated: false }; }
  postMessage(data) {
    const copy = structuredClone(data);
    this.queue = this.queue.then(() => this.handle(copy));
  }
  emit(message) { if (this.onmessage) this.onmessage({ data: message }); }
  async handle(data) {
    if (this.failed || this.dead) return;
    try {
      if (data.kind === 'init') {
        const module = await WebAssembly.compile(data.wasm);
        const host = guestImports(module, this.out);
        this.instance = await WebAssembly.instantiate(module, host.imports);
        host.bind(this.instance);
        this.type = data.type;
        this.instance.exports.actor_init(this.type);
        this.emit({ kind: 'ready' });
      } else {
        this.out.text = '';
        this.instance.exports.actor_receive(this.type, data.value, BigInt(data.sequence));
        this.emit({ kind: 'done', sequence: data.sequence, stdout: this.out.text });
      }
    } catch (error) {
      this.failed = true;
      this.emit({ kind: 'fault', message: describePanic(this.instance, error), stdout: this.out.text });
    }
  }
  terminate() { this.dead = true; FakeWorker.live--; }
}

async function runActors(source) {
  const compiled = compiler.compile(source);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
  const module = await WebAssembly.compile(compiled.wasm);
  const out = { text: '', truncated: false };
  const host = createActorHost({ wasm: compiled.wasm, names: actorNames(module), out, WorkerImpl: FakeWorker, workerUrl: 'actor-worker.js' });
  const { imports, bind } = guestImports(module, out, host);
  const instance = await WebAssembly.instantiate(module, imports);
  bind(instance);
  let value, fault;
  try { value = instance.exports.main(); fault = await host.drain(); }
  catch (error) { fault = describePanic(instance, error); }
  host.close();
  return { value, fault, stdout: out.text, actors: host.count };
}

const COUNTER = `define actor Counter as
  let int total = 0;
  receive(ActorMail<int> mail): void {
    self.total = self.total + mail.value;
    stdio.println(self.total);
    return;
  }
end
`;

test('actor state is private per instance and mail is FIFO with sequence numbers', async () => {
  const r = await runActors(COUNTER + `pub fnc main(): int {
  val a = spawn Counter();
  val b = spawn Counter();
  a.send(40); a.send(2); b.send(7);
  stdio.println("main done");
  return 5;
}`);
  assert.equal(r.fault, null);
  assert.equal(r.value, 5n);
  assert.equal(r.actors, 2);
  assert.ok(r.stdout.startsWith('main done\n'), 'main runs to completion first');
  const lines = r.stdout.trim().split('\n').slice(1);
  assert.deepEqual(lines.filter(l => l !== '7'), ['40', '42'], 'actor a sees its own mail in order');
  assert.ok(lines.includes('7'), 'actor b has independent state');
  assert.equal(FakeWorker.live, 0, 'every actor worker is terminated');
});

test('a panicking actor fails the run with its name, keeping earlier output', async () => {
  const r = await runActors(`define actor W as
  receive(ActorMail<int> mail): void {
    stdio.println(mail.value);
    stdio.println(mail.value * 9223372036854775807);
    return;
  }
end
pub fnc main(): int { val w = spawn W(); w.send(7); w.send(8); return 0; }`);
  assert.equal(r.fault, 'E_PANIC: integer overflow in actor W#0');
  assert.equal(r.stdout, '7\n');
});

test('actor count and mailbox size are bounded', async () => {
  let r = await runActors(COUNTER + `pub fnc main(): int {
  for (let i = 0; i < ${MAX_ACTORS + 1}; i++) { val c = spawn Counter(); }
  return 0;
}`);
  assert.match(r.fault, /^E_ACTOR_LIMIT: at most 16 actors per run/);
  r = await runActors(`define actor Sink as
  receive(ActorMail<int> mail): void { return; }
end
pub fnc main(): int {
  val s = spawn Sink();
  for (let i = 0; i <= ${MAX_MAILBOX}; i++) { s.send(i); }
  return 0;
}`);
  assert.match(r.fault, /^E_MAILBOX_FULL: actor Sink#0 already has 10000 messages/);
});

test('host rejects forged references, types and payloads', () => {
  const out = { text: '', truncated: false };
  const host = createActorHost({ wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]), names: ['A'], out, WorkerImpl: FakeWorker, workerUrl: 'x' });
  assert.throws(() => host.spawn(1), /unknown actor type/);
  assert.throws(() => host.spawn(-1), /unknown actor type/);
  assert.throws(() => host.send(0, 1n), /invalid actor reference/);
  const ref = host.spawn(0);
  assert.throws(() => host.send(ref, 1), /signed 64-bit/);
  assert.throws(() => host.send(ref, 2n ** 63n), /signed 64-bit/);
  host.close();
  assert.throws(() => host.spawn(0), /closed/);
});

test('guest actor tables are validated', async () => {
  const plain = compiler.compile('pub fnc main(): int { return 0; }');
  assert.deepEqual(actorNames(await WebAssembly.compile(plain.wasm)), []);
  // a module claiming actor exports without the atto.actors table is refused
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0, 1,4,1,96,0,0, 3,2,1,0, 7,14,1,10,97,99,116,111,114,95,105,110,105,116,0,0, 10,4,1,2,0,11]);
  assert.throws(() => actorNames(new WebAssembly.Module(bytes)), /actor table missing/);
});


test('a fault in one actor does not abandon another worker\'s outstanding mail', async () => {
  const workers = [];
  class ScriptedWorker {
    constructor() { this.ref = workers.length; this.live = true; workers.push(this); }
    postMessage(message) {
      if (message.kind === 'init') {
        queueMicrotask(() => this.onmessage?.({ data: { kind: 'ready' } }));
      } else if (this.ref === 0) {
        queueMicrotask(() => this.onmessage?.({
          data: { kind: 'fault', message: 'E_PANIC: synthetic failure', stdout: 'bad\n' }
        }));
      } else {
        setTimeout(() => {
          if (this.live) this.onmessage?.({
            data: { kind: 'done', sequence: message.sequence, stdout: 'good\n' }
          });
        }, 10);
      }
    }
    terminate() { this.live = false; }
  }

  const out = { text: '', truncated: false };
  const host = createActorHost({
    wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    names: ['Bad', 'Good'], out, WorkerImpl: ScriptedWorker, workerUrl: 'actor-worker.js'
  });
  const bad = host.spawn(0), good = host.spawn(1);
  host.send(bad, 7n);
  host.send(good, 1n);
  host.send(good, 2n);
  const fault = await host.drain();
  assert.equal(fault, 'E_PANIC: synthetic failure in actor Bad#0');
  assert.equal(out.text, 'bad\ngood\ngood\n', 'sibling finishes after the first fault');
  assert.throws(() => host.send(bad, 8n), /E_ACTOR_DEAD/);
  assert.equal(workers[0].live, false, 'failed worker was reclaimed');
  host.close();
  assert.equal(workers.every(w => !w.live), true);
});

test('drain waits for asynchronous actor initialization even without mail', async () => {
  class InitFailureWorker {
    postMessage() {
      setTimeout(() => this.onmessage?.({
        data: { kind: 'fault', message: 'E_ACTOR: startup failed' }
      }), 5);
    }
    terminate() {}
  }
  const host = createActorHost({
    wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    names: ['Broken'], out: { text: '', truncated: false },
    WorkerImpl: InitFailureWorker, workerUrl: 'actor-worker.js'
  });
  host.spawn(0);
  const fault = await host.drain();
  assert.equal(fault, 'E_ACTOR: startup failed in actor Broken#0');
  host.close();
});

test('real guest Wasm panic terminates only its actor while a sibling finishes', async () => {
  const r = await runActors(`define actor W as
  receive(ActorMail<int> mail): void {
    stdio.println(mail.value);
    stdio.println(mail.value * 9223372036854775807);
    return;
  }
end
pub fnc main(): int {
  val bad = spawn W();
  val good = spawn W();
  bad.send(7);
  good.send(0);
  good.send(0);
  return 0;
}`);
  assert.equal(r.fault, 'E_PANIC: integer overflow in actor W#0');
  assert.equal(r.stdout.split('\n').filter(Boolean).length, 5,
    'one bad print and four healthy sibling prints must survive');
  assert.equal(r.stdout.split('\n').filter(Boolean).filter(x => x === '0').length, 4);
  assert.equal(FakeWorker.live, 0);
});


test('mailbox admission freezes during drain and a concurrent drain is rejected', async () => {
  class ScriptedWorker {
    postMessage(message) {
      if (message.kind === 'init') {
        queueMicrotask(() => this.onmessage?.({ data: { kind: 'ready' } }));
      } else {
        queueMicrotask(() => this.onmessage?.({
          data: { kind: 'done', sequence: message.sequence }
        }));
      }
    }
    terminate() {}
  }
  const host = createActorHost({
    wasm: new Uint8Array([0,97,115,109,1,0,0,0]),
    names: ['W'], out: { text: '', truncated: false },
    WorkerImpl: ScriptedWorker, workerUrl: 'actor-worker.js'
  });
  const a = host.spawn(0);
  host.send(a, 1n);
  const draining = host.drain();
  assert.throws(() => host.drain(), /E_ACTOR_PROTOCOL: concurrent drains/);
  assert.throws(() => host.spawn(0), /spawn admission closed/);
  assert.throws(() => host.send(a, 2n), /mailbox admission closed/);
  assert.equal(await draining, null);
  assert.equal(await host.drain(), null, 'subsequent drain is idempotent');
  host.close();
});

test('closing the host settles a pending drain and terminates workers exactly once', async () => {
  class SilentWorker {
    static instances = [];
    constructor() { this.terminations = 0; SilentWorker.instances.push(this); }
    postMessage() {} // no ready/done acknowledgement
    terminate() { this.terminations++; }
  }
  const host = createActorHost({
    wasm: new Uint8Array([0,97,115,109,1,0,0,0]),
    names: ['W'], out: { text: '', truncated: false },
    WorkerImpl: SilentWorker, workerUrl: 'actor-worker.js'
  });
  const a = host.spawn(0);
  host.send(a, 1n);
  const pending = host.drain();
  host.close();
  assert.equal(await pending, 'E_ACTOR: actor host closed');
  assert.equal(await host.drain(), 'E_ACTOR: actor host closed');
  host.close();
  assert.deepEqual(SilentWorker.instances.map(w => w.terminations), [1]);
});

class ControlledActorWorker {
  static instances = [];
  constructor() {
    this.messages = [];
    this.terminations = 0;
    ControlledActorWorker.instances.push(this);
  }
  postMessage(data) { this.messages.push(data); }
  emit(data) { this.onmessage?.({ data }); }
  terminate() { this.terminations++; }
}
function controlledActorHost() {
  const out = { text: '', truncated: false };
  const host = createActorHost({
    wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    names: ['Pending'], out, WorkerImpl: ControlledActorWorker, workerUrl: 'actor-worker.js'
  });
  host.spawn(0);
  return { host, worker: ControlledActorWorker.instances.at(-1), out };
}

test('drain waits for actor initialization even without any mailbox messages', async () => {
  const { host, worker, out } = controlledActorHost();
  let settled = false;
  const pending = host.drain().then(result => { settled = true; return result; });
  await Promise.resolve();
  assert.equal(settled, false, 'main returning before actor_init must not indicate success');
  worker.emit({ kind: 'ready', stdout: 'initialized\n' });
  assert.equal(await pending, null);
  assert.equal(out.text, 'initialized\n');
  host.close();
});

test('actor initialization faults are reported when no messages were sent', async () => {
  const { host, worker } = controlledActorHost();
  const pending = host.drain();
  worker.emit({ kind: 'fault', message: 'E_PANIC: actor init failed' });
  assert.equal(await pending, 'E_PANIC: actor init failed in actor Pending#0');
  host.close();
});

test('duplicate readiness and completion before readiness are fail-closed', async () => {
  const first = controlledActorHost();
  const initial = first.host.drain();
  first.worker.emit({ kind: 'ready' });
  assert.equal(await initial, null);
  first.worker.emit({ kind: 'ready' });
  assert.match(await first.host.drain(), /E_ACTOR_PROTOCOL: duplicate or late actor readiness/);
  first.host.close();

  const second = controlledActorHost();
  const pending = second.host.drain();
  second.worker.emit({ kind: 'done', sequence: 0 });
  assert.match(await pending, /E_ACTOR_PROTOCOL: unexpected actor completion/);
  second.host.close();
});

test('closing a pending actor host settles drain and terminates once', async () => {
  const { host, worker } = controlledActorHost();
  const pending = host.drain();
  host.close();
  assert.equal(await pending, 'E_ACTOR: actor host closed');
  host.close();
  assert.equal(worker.terminations, 1);
});

class ThrowingInitWorker extends ControlledActorWorker {
  postMessage() { throw new Error('DataCloneError: failed to queue init'); }
}

test('failed actor initialization handoff releases worker and preserves host count', async () => {
  const out = { text: '', truncated: false };
  const host = createActorHost({
    wasm: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    names: ['Pending'], out, WorkerImpl: ThrowingInitWorker, workerUrl: 'actor-worker.js'
  });
  const existing = ControlledActorWorker.instances.length;
  assert.throws(() => host.spawn(0), /DataCloneError/);
  assert.equal(host.count, 0, 'failed spawn must not reserve an actor reference');
  assert.equal(ControlledActorWorker.instances.length, existing + 1);
  assert.equal(ControlledActorWorker.instances.at(-1).terminations, 1, 'orphan worker must be terminated');
  assert.equal(await host.drain(), null);
  host.close();
});

test('overlapping drains fail closed instead of losing the original promise', async () => {
  const { host, worker } = controlledActorHost();
  const first = host.drain();
  assert.throws(() => host.drain(), /E_ACTOR_PROTOCOL: concurrent drains/);
  worker.emit({ kind: 'ready' });
  assert.equal(await first, null, 'the original caller must still complete');
  host.close();
  assert.equal(await host.drain(), 'E_ACTOR: actor host closed');
});

test('legacy actor host owns admitted Wasm bytes and actor names across late spawn', async () => {
  const original = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  const names = ['Original'];
  const instances = [];
  class SnapshotWorker {
    constructor() { this.sent = []; this.terminated = false; instances.push(this); }
    postMessage(message) { this.sent.push(structuredClone(message)); }
    terminate() { this.terminated = true; }
  }
  const host = createActorHost({
    wasm: original, names, out: { text: '', truncated: false },
    WorkerImpl: SnapshotWorker, workerUrl: 'snapshot-worker.js'
  });
  original[0] = 255;
  names[0] = 'Attacker';
  names.push('Injected');
  assert.throws(() => host.spawn(1), /unknown actor type/,
    'new actor types are not injected through the caller-owned array');
  const ref = host.spawn(0);
  assert.equal(ref, 0);
  assert.deepEqual(instances[0].sent[0].wasm,
    new Uint8Array([0,97,115,109,1,0,0,0]),
    'Worker receives the admitted private byte snapshot');
  const drained = host.drain();
  instances[0].onmessage({data:{kind:'fault',message:'E_PANIC: actor failed'}});
  assert.match(await drained, /E_PANIC: actor failed in actor Original#0/);
  assert.equal(instances[0].terminated, true);
  host.close();
});

test('legacy actor host refuses shared and oversized guest input before any Worker creation', () => {
  let created = 0;
  class CountingWorker { constructor() { created++; } }
  const options = {
    names:['Counter'], out:{text:'',truncated:false},
    WorkerImpl:CountingWorker, workerUrl:'x'
  };
  assert.throws(() => createActorHost({...options,wasm:new Uint8Array((1<<20)+1)}),
    /invalid\/oversized guest bytes/);
  assert.throws(() => createActorHost({...options,wasm:new Uint8Array(7)}),
    /invalid\/oversized guest bytes/);
  if (typeof SharedArrayBuffer !== 'undefined') {
    assert.throws(() => createActorHost({
      ...options, wasm:new Uint8Array(new SharedArrayBuffer(8))
    }), /requires private Uint8Array/);
  }
  assert.equal(created,0,'rejected inputs allocate no child Workers');
});
