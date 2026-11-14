import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantActorHost } from '../src/tenant-actor-host.js';

// This constructs a real, minimal core-Wasm actor module; no stubbed guest
// instances or JavaScript reimplementation of Wasm actor memory.
function leb(value) {
  const bytes = [];
  do {
    let byte = value & 127;
    value >>>= 7;
    if (value) byte |= 128;
    bytes.push(byte);
  } while (value);
  return bytes;
}
function flat(...parts) { return parts.flat(Infinity); }
function str(value) {
  const bytes = [...new TextEncoder().encode(value)];
  return [...leb(bytes.length), ...bytes];
}
function section(id, bytes) { return [id, ...leb(bytes.length), ...bytes]; }
function exportEntry(name, kind, index) { return [...str(name), kind, ...leb(index)]; }
function code(...instructions) {
  const body = [0, ...instructions, 0x0b]; // zero local groups, end
  return [...leb(body.length), ...body];
}

function actorFixture() {
  // Imports: atto.print_i64(i64). Exports: main, panic_code, memory,
  // actor_init, actor_receive. Each instance stores its actor state at
  // memory address 0; this proves linear memories are independent.
  const main = code(0x42, 0x00); // i64.const 0
  const init = code(
    0x41, 0x00,               // i32.const 0 (address)
    0x20, 0x00,               // local.get 0 (type index)
    0x36, 0x02, 0x00          // i32.store
  );
  const receive = code(
    0x20, 0x01, 0x42, 0x07, 0x51, // mail value == 7?
    0x04, 0x40, 0x00, 0x0b,       // if (then unreachable) end
    0x41, 0x00,                   // i32.const 0 (store address)
    0x41, 0x00, 0x28, 0x02, 0x00, // i32.load from 0
    0x41, 0x01, 0x6a,             // add 1
    0x36, 0x02, 0x00,             // store at 0
    0x41, 0x00, 0x28, 0x02, 0x00, // load state
    0xac,                         // i64.extend_i32_s
    0x10, 0x00                    // call imported print_i64
  );
  return new Uint8Array(flat(
    [0, 97, 115, 109, 1, 0, 0, 0],
    section(1, flat([4],
      [0x60, 0, 1, 0x7e],                     // () -> i64
      [0x60, 1, 0x7f, 0],                      // (i32) -> ()
      [0x60, 3, 0x7f, 0x7e, 0x7e, 0],         // (i32,i64,i64) -> ()
      [0x60, 1, 0x7e, 0])),                   // (i64) -> ()
    section(2, flat([1], str('atto'), str('print_i64'), [0, 3])),
    section(3, [3, 0, 1, 2]),
    section(5, [1, 1, 1, 1]),                // 1-page memory min=max
    section(6, [1, 0x7f, 1, 0x41, 0, 0x0b]), // panic_code global
    section(7, flat([5],
      exportEntry('main', 0, 1),
      exportEntry('actor_init', 0, 2),
      exportEntry('actor_receive', 0, 3),
      exportEntry('memory', 2, 0),
      exportEntry('panic_code', 3, 0))),
    section(10, flat([3], main, init, receive))
  ));
}

test('one tenant schedules two actors with truly independent Wasm32 linear memories', async () => {
  const bytes = actorFixture();
  assert.equal(WebAssembly.validate(bytes), true);
  const module = new WebAssembly.Module(bytes);
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({ module, names: ['Counter'], out });
  const first = host.spawn(0), second = host.spawn(0);
  assert.deepEqual([first, second], [0, 1]);
  assert.equal(host.memoryBytes, 2 * 65536);
  host.send(first, 10n);
  host.send(first, 11n);
  host.send(second, 12n);
  assert.equal(await host.drain(), null);
  assert.equal(out.text, '112'); // round-robin; each private memory starts at zero
  host.close();
  assert.equal(host.memoryBytes, 0);
  assert.equal(host.count, 2);
});

test('Wasm trap kills only its actor; healthy siblings finish', async () => {
  const module = new WebAssembly.Module(actorFixture());
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({ module, names: ['Counter'], out });
  const bad = host.spawn(0), healthy = host.spawn(0);
  host.send(bad, 1n);
  host.send(bad, 7n); // trap in only this instance
  host.send(healthy, 1n);
  host.send(healthy, 2n);
  const fault = await host.drain();
  assert.match(fault, /E_RUNTIME: .* in actor Counter#0/);
  assert.equal(out.text, '112'); // healthy actor processed both messages
  host.close();
});

test('tenant host enforces ref, mailbox, and 64-bit message boundaries', async () => {
  const module = new WebAssembly.Module(actorFixture());
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({ module, names: ['Counter'], out });
  const actor = host.spawn(0);
  assert.throws(() => host.send(99, 1n), /invalid actor reference/);
  assert.throws(() => host.send(actor, 1), /signed 64-bit/);
  assert.throws(() => host.send(actor, 1n << 63n), /signed 64-bit/);
  assert.throws(() => host.spawn(9), /unknown actor type/);
  host.send(actor, -(1n << 63n));
  assert.equal(await host.drain(), null);
  host.close();
  assert.throws(() => host.spawn(0), /tenant closed/);
});

test('v2 mailbox and spawn admission close permanently when drain begins', async () => {
  const module = new WebAssembly.Module(actorFixture());
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({ module, names: ['Counter'], out });
  const a = host.spawn(0);
  host.send(a, 1n);
  assert.equal(await host.drain(), null);
  assert.throws(() => host.send(a, 2n), /mailbox admission closed/);
  assert.throws(() => host.spawn(0), /spawn admission closed/);
  assert.equal(await host.drain(), null, 'second drain must not reopen admissions');
  host.close();
});

test('closing during a yield cancels queued Wasm mail instead of resuming dead instances', async () => {
  const module = new WebAssembly.Module(actorFixture());
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({ module, names: ['Counter'], out });
  const a = host.spawn(0);
  for (let i = 0; i < 80; i++) host.send(a, 1n);
  const draining = host.drain(); // reaches its 64-message yield
  host.close();
  assert.equal(await draining, 'E_ACTOR: tenant closed');
  assert.equal(host.memoryBytes, 0);
  assert.throws(() => host.send(a, 1n), /tenant closed/);
});

test('tenant scheduler resolves the public Symbol manifest and rejects bogus mailbox IDs', async () => {
  const raw = actorFixture();
  const typeNames = section(0, flat(str('atto.symbols'), [2], str('#ready'), str('#stopped')));
  const mail = section(0, flat(str('atto.actor_mail'), [1,3]));
  const module = new WebAssembly.Module(new Uint8Array([...raw, ...typeNames, ...mail]));
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({ module, names: ['Worker'], out });
  assert.equal(host.symbols.count, 2);
  const global = host.symbols.get('#ready');
  assert.equal(host.symbols.same(global, structuredClone(global)), true);
  assert.equal(host.symbols.get('#unknown'), null);
  assert.equal(typeof host.symbols.internGlobal, 'undefined');
  assert.equal(typeof host.symbols.internLocal, 'undefined');
  const worker = host.spawn(0);
  assert.throws(() => host.send(worker, 0n), /E_SYMBOL_UNBOUND/);
  assert.throws(() => host.send(worker, 3n), /E_SYMBOL_UNBOUND/);
  host.send(worker, 1n);
  assert.equal(await host.drain(), null);
  assert.equal(out.text, '1');
  host.close();
});

test('typed bool and no-receiver mailboxes fail closed in both actor-host backends', async () => {
  const { createActorHost } = await import('../src/actor-host.js');
  class StubWorker { postMessage() {} terminate() {} }
  for (const kind of [0,2]) {
    const source = new Uint8Array([...actorFixture(), ...section(0, flat(str('atto.actor_mail'), [1,kind]))]);
    assert.equal(WebAssembly.validate(source), true);
    const module = new WebAssembly.Module(source);
    const out = {text:'', truncated:false};
    const tenant = createTenantActorHost({module,names:['Counter'],out});
    const worker = createActorHost({wasm:source,names:['Counter'],out,WorkerImpl:StubWorker,workerUrl:'unused'});
    const ta=tenant.spawn(0), wa=worker.spawn(0);
    const code=kind===0?/E_ACTOR_NO_RECEIVE/:/E_ACTOR_MAIL_TYPE/;
    assert.throws(()=>tenant.send(ta,2n),code);
    assert.throws(()=>worker.send(wa,2n),code);
    assert.throws(()=>tenant.send(ta,-1n),code);
    assert.throws(()=>worker.send(wa,-1n),code);
    if(kind===2){
      tenant.send(ta,1n);
      worker.send(wa,1n);
      tenant.send(ta,0n);
      worker.send(wa,0n);
      assert.equal(await tenant.drain(),null);
      assert.equal(out.text,'12');
    }else{
      assert.throws(()=>tenant.send(ta,0n),code);
      assert.throws(()=>worker.send(wa,0n),code);
    }
    tenant.close();
    worker.close();
  }
});
