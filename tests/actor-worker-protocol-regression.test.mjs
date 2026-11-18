import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';

// Node executes the actual generated Atto guest in an isolated actor-worker
// module context. This is an in-process protocol test, not a browser isolation
// proof; real Chromium source-to-Worker execution is covered by browser-e2e.
const compilerBytes = await readFile(new URL('../public/atto_compiler.wasm', import.meta.url));
const compiler = await createCompiler(compilerBytes);
const source = `define actor Counter as
  let int total = 0;
  receive(ActorMail<int> mail): void {
    self.total = self.total + mail.value;
    stdio.println(self.total);
    return;
  }
end
pub fnc main(): int {
  val counter = spawn Counter();
  counter.send(7);
  return 0;
}`;
const compiled = compiler.compile(source);
assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
const guest = compiled.wasm;
let nextWorker = 0;

async function session() {
  const oldSelf = globalThis.self;
  const events = [];
  const scope = {
    postMessage(data) { events.push(structuredClone(data)); }
  };
  globalThis.self = scope;
  try {
    await import('../src/actor-worker.js?protocol-replay-regression=' + ++nextWorker);
  } catch (error) {
    globalThis.self = oldSelf;
    throw error;
  }
  const send = data => scope.onmessage({data: structuredClone(data)});
  const wait = async count => {
    const deadline = Date.now() + 5000;
    while (events.length < count && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(events.length >= count, 'actor did not reply to the protocol request');
    return events[count - 1];
  };
  const close = () => { globalThis.self = oldSelf; };
  return { send, wait, events, close };
}

async function ready(session, type = 0) {
  session.send({kind:'init', wasm:new Uint8Array(guest), type});
  return session.wait(1);
}

test('real source-compiled actor admits consecutive 0-based mail exactly once', async () => {
  const w = await session();
  try {
    assert.deepEqual(await ready(w), {kind:'ready', stdout:'', truncated:false});
    w.send({kind:'mail',value:7n,sequence:0});
    assert.deepEqual(await w.wait(2), {kind:'done',sequence:0,stdout:'7\n',truncated:false});
    w.send({kind:'mail',value:3n,sequence:1});
    assert.deepEqual(await w.wait(3), {kind:'done',sequence:1,stdout:'10\n',truncated:false});
  } finally { w.close(); }
});

test('duplicate delivery is rejected with no second guest invocation', async () => {
  const w=await session();
  try {
    await ready(w);
    w.send({kind:'mail',value:7n,sequence:0});
    assert.equal((await w.wait(2)).kind,'done');
    w.send({kind:'mail',value:7n,sequence:0});
    assert.match((await w.wait(3)).message,/^E_ACTOR_PROTOCOL: out-of-order or replayed/);
    w.send({kind:'mail',value:5n,sequence:1});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(w.events.length,3,'terminal actor must ignore all later mail');
  } finally { w.close(); }
});

test('missing, negative, fractional and overflowed sequences fail before executing guest', async t => {
  for(const sequence of [1,-1,0.5,Number.MAX_SAFE_INTEGER]) {
    await t.test('sequence ' + sequence, async () => {
      const w=await session();
      try {
        await ready(w);
        w.send({kind:'mail',value:9n,sequence});
        const fault=await w.wait(2);
        assert.equal(fault.kind,'fault');
        assert.match(fault.message,/^E_ACTOR_PROTOCOL: out-of-order or replayed/);
        assert.equal(fault.stdout,'');
      } finally { w.close(); }
    });
  }
});

test('both signed-i64 overflow directions and non-BigInt transport are rejected', async t => {
  for(const value of [2n ** 63n,-(2n ** 63n)-1n,42,'42']) {
    await t.test('payload '+String(value), async()=>{
      const w=await session();
      try{
        await ready(w);
        w.send({kind:'mail',value,sequence:0});
        const fault=await w.wait(2);
        assert.equal(fault.kind,'fault');
        assert.match(fault.message,/^E_ACTOR_PROTOCOL: mail must be a signed 64-bit value/);
        assert.equal(fault.stdout,'');
      }finally{w.close();}
    });
  }
});

test('source actor index must match declared atto.actors table', async()=>{
  const w=await session();
  try {
    const fault=await ready(w,1);
    assert.equal(fault.kind,'fault');
    assert.match(fault.message,/Invalid actor type/);
    assert.equal(w.events.some(event=>event.kind==='ready'),false);
  } finally {w.close();}
});

test('duplicate initialization is terminal and cannot reset actor mailbox state', async()=>{
  const w=await session();
  try{
    await ready(w);
    w.send({kind:'init',wasm:new Uint8Array(guest),type:0});
    const fault=await w.wait(2);
    assert.equal(fault.kind,'fault');
    assert.match(fault.message,/Actor protocol violation/);
    w.send({kind:'mail',value:1n,sequence:0});
    await new Promise(resolve=>setTimeout(resolve,30));
    assert.equal(w.events.length,2);
  }finally{w.close();}
});
