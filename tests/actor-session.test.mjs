import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorSession, parseActorMessage, ActorCompileError } from '../src/actor-session.js';
import { COUNTER_WASM } from './actor-fixture.mjs';

const bytes = () => new Uint8Array(COUNTER_WASM);
const tick = () => new Promise(resolve => setImmediate(resolve));

test('signed i64 message entry is exact, never coerced through JS Number', () => {
  for (const [input, expected] of [['41',41n],['-1',-1n],
    ['9223372036854775807',(1n<<63n)-1n],['-9223372036854775808',-(1n<<63n)]]) {
    assert.equal(parseActorMessage(input), expected);
  }
  for (const input of ['', '1.3', '1e3', 'Infinity', '01',
    '9223372036854775808', '-9223372036854775809', '9'.repeat(5000)]) {
    assert.throws(() => parseActorMessage(input), /E_ACTOR_MESSAGE/);
  }
});

test('no source-code evaluation: validated compiler-produced Wasm goes to actor runtime', async () => {
  const calls = [];
  let closed = false;
  const session = createActorSession({
    compile: async source => {
      calls.push(['compile', source]);
      return {ok:true,wasm:bytes()};
    },
    spawn: async wasm => {
      calls.push(['spawn',WebAssembly.validate(wasm)]);
      return {send: async x => x + 1n,close(){closed=true;},get closed(){return closed;}};
    },
  });
  await session.start('define actor A as receive(int x): int { return x + 1; } end');
  assert.equal(session.active, true);
  assert.equal(await session.send(41n), 42n);
  await assert.rejects(session.send(41), /E_ACTOR_MESSAGE/);
  session.stop();
  assert.equal(closed, true);
  assert.equal(session.active, false);
  await assert.rejects(session.send(1n), /E_ACTOR_CLOSED/);
  assert.deepEqual(calls.map(x=>x[0]),['compile','spawn']);
});

test('compiler failures cannot spawn any actor or expose an artifact', async () => {
  let called = 0;
  const spawn = async () => {called++;throw Error('should not spawn');};
  for (const reply of [
    {ok:false,diagnostics:[{line:4,column:3,message:'E_ACTOR_ABI: missing compile_actor'}]},
    {ok:false,wasm:bytes()},
    {ok:true,wasm:new Uint8Array([0,97,115,109])},
    {ok:true,wasm:new Uint8Array(8)},
    {ok:true,wasm:null},
    {oops:true},
  ]) {
    const session = createActorSession({compile: async()=>reply,spawn});
    await assert.rejects(session.start('source'));
    assert.equal(session.active,false);
    session.stop();
  }
  assert.equal(called,0);
  const session=createActorSession({compile:async()=>({ok:false,diagnostics:[{message:'E_ACTOR_ABI: missing compile_actor'}]})});
  await assert.rejects(session.start('source'), error => error instanceof ActorCompileError && /E_ACTOR_ABI/.test(error.message));
});

test('stop during in-flight compilation fences stale guest and never spawns', async () => {
  let release, spawned=0;
  const session = createActorSession({
    compile: () => new Promise(resolve=> {release=resolve;}),
    spawn: async()=>{spawned++;return {close(){},send:async x=>x};},
  });
  const pending=session.start('actor');
  assert.equal(session.starting,true);
  session.stop();
  release({ok:true,wasm:bytes()});
  await assert.rejects(pending,/E_ACTOR_CANCELLED/);
  await tick();
  assert.equal(spawned,0);
  assert.equal(session.active,false);
});

test('stop during worker initialization closes late actor handle', async () => {
  let release,closed=0;
  const session=createActorSession({
    compile:async()=>({ok:true,wasm:bytes()}),
    spawn:()=>new Promise(resolve=>{release=resolve;}),
  });
  const pending=session.start('actor');
  await tick();
  session.stop();
  release({close(){closed++;},send:async x=>x});
  await assert.rejects(pending,/E_ACTOR_CANCELLED/);
  assert.equal(closed,1);
});

test('actor session rejects a second start, resumes after explicit stop', async () => {
  const session=createActorSession({
    compile:async()=>({ok:true,wasm:bytes()}),
    spawn:async()=>({close(){},send:async x=>x,closed:false}),
  });
  await session.start('actor');
  await assert.rejects(session.start('actor'),/E_ACTOR_ALREADY_RUNNING/);
  session.stop();
  await session.start('actor');
  session.stop();
});

test('invalid spawn handles never leak an initialized worker', async () => {
  let closed = 0;
  for (const handle of [
    {close() { closed++; }},
    {close() { closed++; },send: 42},
    null,
  ]) {
    const session = createActorSession({
      compile: async () => ({ok:true,wasm:bytes()}),
      spawn: async () => handle,
    });
    await assert.rejects(session.start('actor'), /E_ACTOR_PROTOCOL/);
    assert.equal(session.active,false);
    session.stop();
  }
  assert.equal(closed,2);
});

test('stop during initialization tolerates absent handles and never revives a worker', async () => {
  let release;
  const session=createActorSession({
    compile:async()=>({ok:true,wasm:bytes()}),
    spawn:()=>new Promise(resolve=>{release=resolve;}),
  });
  const pending=session.start('actor');
  await tick();
  session.stop();
  release(null);
  await assert.rejects(pending,/E_ACTOR_CANCELLED/);
  assert.equal(session.active,false);
});
