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
  constructor() { FakeWorker.live++; this.queue = Promise.resolve(); this.out = { text: '', truncated: false }; this.generation = 0; }
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
        this.generation = data.generation;
        this.instance.exports.actor_init(this.type);
        this.emit({ kind: 'ready', generation: this.generation });
      } else {
        this.out.text = '';
        this.instance.exports.actor_receive(this.type, data.value, BigInt(data.sequence));
        this.emit({ kind: 'done', generation: this.generation, sequence: data.sequence, stdout: this.out.text });
      }
    } catch (error) {
      this.failed = true;
      this.emit({ kind: 'fault', generation: this.generation, message: describePanic(this.instance, error), stdout: this.out.text });
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

test('out-of-epoch acknowledgements and output cannot consume mailbox messages', async () => {
  class MockWorker {
    static instances = [];
    constructor() { this.sent = []; this.dead = false; MockWorker.instances.push(this); }
    postMessage(x) { this.sent.push(x); }
    terminate() { this.dead = true; }
    emit(data) { this.onmessage?.({ data }); }
  }
  const out = { text: '', truncated: false };
  const host = createActorHost({
    wasm: new Uint8Array([0,97,115,109,1,0,0,0]), names: ['A'], out,
    WorkerImpl: MockWorker, workerUrl: 'mock'
  });
  const a = host.spawn(0);
  assert.equal(a, 0);
  const worker = MockWorker.instances.at(-1);
  const generation = worker.sent[0].generation;
  assert.equal(Number.isInteger(generation), true);
  assert.ok(generation > 0);
  host.send(a, 42n);
  worker.emit({kind:'done',generation:generation + 1,sequence:0,stdout:'STALE\n'});
  worker.emit({kind:'fault',generation:generation + 1,message:'E_ACTOR: stale fault'});
  assert.equal(out.text, '');
  worker.emit({kind:'ready',generation});
  worker.emit({kind:'done',generation,sequence:0,stdout:'42\n'});
  assert.equal(await host.drain(), null, 'valid same-generation done drains mailbox');
  assert.equal(out.text,'42\n','stale stdout must not leak');
  host.close();
  assert.equal(worker.dead,true);
  worker.emit({kind:'done',generation,sequence:1,stdout:'ZOMBIE\n'});
  assert.equal(out.text,'42\n');
});

test('cancelling an actor host settles its drain and invalidates its generation', async () => {
  class MockWorker {
    constructor() { this.sent=[]; this.dead=false; }
    postMessage(x) { this.sent.push(x); }
    terminate() { this.dead=true; }
  }
  const out={text:'',truncated:false};
  const host=createActorHost({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),names:['A'],out,WorkerImpl:MockWorker,workerUrl:'mock'});
  const a=host.spawn(0);
  host.send(a,4n);
  const waiting=host.drain();
  host.close();
  assert.equal(await waiting,'E_ACTOR_CANCELLED: actor host closed');
  assert.throws(()=>host.send(a,1n),/closed/);
  assert.equal(out.text,'');
});

test('actor initialization faults are attributed to the current generation', async () => {
  class InitFaultWorker {
    static latest;
    constructor() { this.mail=[]; InitFaultWorker.latest=this; }
    postMessage(message) { this.mail.push(message); }
    terminate() { this.dead=true; }
    emit(data) { this.onmessage?.({data}); }
  }
  const out={text:'',truncated:false};
  const host=createActorHost({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),names:['Broken'],out,WorkerImpl:InitFaultWorker,workerUrl:'x'});
  const ref=host.spawn(0);
  host.send(ref,42n);
  const generation=InitFaultWorker.latest.mail[0].generation;
  assert.ok(generation>0);
  InitFaultWorker.latest.emit({kind:'fault',generation,message:'E_RUNTIME: invalid guest at actor initialization'});
  assert.equal(await host.drain(),'E_RUNTIME: invalid guest at actor initialization in actor Broken#0');
  host.close();
  assert.equal(InitFaultWorker.latest.dead,true);
});

test('failed actor is quarantined but already-sent sibling mail completes before fault report', async () => {
  const r = await runActors(`define actor Broken as
    receive(ActorMail<int> mail): void {
      stdio.println(mail.value);
      stdio.println(mail.value * 9223372036854775807);
      return;
    }
  end
  define actor Healthy as
    receive(ActorMail<int> mail): void {
      stdio.println(mail.value);
      return;
    }
  end
  pub fnc main(): int {
    val broken = spawn Broken();
    val healthy = spawn Healthy();
    broken.send(7);
    healthy.send(99);
    return 0;
  }`);
  assert.equal(r.fault, 'E_PANIC: integer overflow in actor Broken#0');
  assert.ok(r.stdout.split('\n').includes('99'),'healthy sibling must complete despite first actor failure');
  assert.equal(FakeWorker.live,0,'all worker resources reclaimed at completion');
});

test('same-generation malformed ACK cannot inject stdout or advance mailbox', async () => {
  class MockWorker {
    static last;
    constructor() { this.posts = []; MockWorker.last = this; }
    postMessage(message) { this.posts.push(message); }
    terminate() {}
    emit(message) { this.onmessage?.({ data: message }); }
  }
  const out = { text: '', truncated: false };
  const host = createActorHost({ wasm: new Uint8Array([0,97,115,109,1,0,0,0]),
    names: ['A'], out, WorkerImpl: MockWorker, workerUrl: 'mock' });
  const ref = host.spawn(0);
  const worker = MockWorker.last;
  const gen = worker.posts[0].generation;
  host.send(ref, 42n);
  worker.emit({ kind: 'ready', generation: gen });
  worker.emit({ kind: 'done', generation: gen, sequence: 999, stdout: 'INJECTED\\n', truncated: true });
  assert.match(await host.drain(), /E_ACTOR_PROTOCOL: invalid completion/);
  assert.equal(out.text, '');
  assert.equal(out.truncated, false);
  worker.emit({ kind: 'done', generation: gen, sequence: 0, stdout: 'LATE\\n' });
  assert.equal(out.text, '');
  host.close();
});

test('unknown messages and duplicated ready cannot inject output', async () => {
  class MockWorker {
    static last;
    constructor() { this.posts = []; MockWorker.last = this; }
    postMessage(message) { this.posts.push(message); }
    terminate() {}
    emit(message) { this.onmessage?.({ data: message }); }
  }
  const invalid = [
    [{ kind: 'arbitrary', stdout: 'INJECTED\\n' }, /unexpected actor worker message/],
    [{ kind: 'ready', stdout: 'INJECTED\\n' }, /duplicate or malformed ready/],
    [{ kind: 'ready' }, /duplicate or malformed ready/],
  ];
  for (const [data, expected] of invalid) {
    const out = {text:'', truncated:false};
    const host = createActorHost({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),
      names:['A'],out,WorkerImpl:MockWorker,workerUrl:'mock'});
    const ref = host.spawn(0);
    const worker = MockWorker.last;
    const generation = worker.posts[0].generation;
    host.send(ref,1n);
    worker.emit({kind:'ready',generation});
    worker.emit({...data,generation});
    assert.match(await host.drain(),expected);
    assert.equal(out.text,'');
    host.close();
  }
});

test('drain is idempotent, seals mailbox and is cancellable even after close', async () => {
  class MockWorker {
    static last;
    constructor() { this.posts=[]; MockWorker.last=this; }
    postMessage(message) {this.posts.push(message);}
    terminate(){}
    emit(message) {this.onmessage?.({data:message});}
  }
  const out={text:'',truncated:false};
  const host=createActorHost({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),
    names:['A'],out,WorkerImpl:MockWorker,workerUrl:'mock'});
  const ref=host.spawn(0),worker=MockWorker.last,generation=worker.posts[0].generation;
  host.send(ref,42n);
  const d1=host.drain(),d2=host.drain();
  assert.equal(d1,d2,'must share exactly one outstanding drain');
  assert.throws(()=>host.send(ref,7n),/sealed for drain/);
  assert.throws(()=>host.spawn(0),/sealed for drain/);
  worker.emit({kind:'ready',generation});
  worker.emit({kind:'done',generation,sequence:0,stdout:'42\\n'});
  assert.equal(await d1,null);
  assert.equal(out.text,'42\\n');
  host.close();
  assert.equal(await host.drain(),'E_ACTOR_CANCELLED: actor host closed');
});

test('an actor with no mail must finish initialization before drain succeeds', async () => {
  class ManualWorker {
    static latest;
    constructor() { this.posts=[]; ManualWorker.latest=this; }
    postMessage(message) { this.posts.push(message); }
    terminate() {}
    emit(message) { this.onmessage?.({ data: message }); }
  }
  const out={text:'',truncated:false};
  const host=createActorHost({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),
    names:['A'],out,WorkerImpl:ManualWorker,workerUrl:'mock'});
  host.spawn(0);
  let drained=false;
  const waiting=host.drain().then(value=>{drained=true;return value;});
  await Promise.resolve();
  assert.equal(drained,false,'empty mailbox must not bypass actor initialization');
  const generation=ManualWorker.latest.posts[0].generation;
  ManualWorker.latest.emit({kind:'ready',generation});
  assert.equal(await waiting,null);
  host.close();
});

test('an actor with no mail must report init failure, not false successful drain', async () => {
  class ManualWorker {
    static latest;
    constructor() { this.posts=[]; ManualWorker.latest=this; }
    postMessage(message) { this.posts.push(message); }
    terminate() {}
    emit(message) { this.onmessage?.({ data: message }); }
  }
  const out={text:'',truncated:false};
  const host=createActorHost({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),
    names:['Bad'],out,WorkerImpl:ManualWorker,workerUrl:'mock'});
  host.spawn(0);
  const waiting=host.drain();
  const generation=ManualWorker.latest.posts[0].generation;
  ManualWorker.latest.emit({kind:'fault',generation,message:'E_RUNTIME: init failed'});
  assert.equal(await waiting,'E_RUNTIME: init failed in actor Bad#0');
  host.close();
});
