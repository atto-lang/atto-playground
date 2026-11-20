/** Host-only JSPI lifecycle model: NOT compiled .atto cancellation or lock release. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createAsyncTaskHost} from '../src/task-host.js';

// The real task-host source is exercised with a constrained fake JSPI shell.
// This proves the JS host does not confuse requested cancellation with a
// settled continuation; it deliberately does NOT claim browser Wasm parity.
test('async/2 host cancellation retains active continuations until settlement', async t => {
  const original = globalThis.WebAssembly;
  globalThis.WebAssembly = {
    Module: {
      customSections: (_, name) => name === 'atto.async' ? [Uint8Array.of(2).buffer] : [],
      imports: () => [{module:'atto',name:'task_start'}],
      exports: () => [{name:'task_invoke',kind:'function'}],
    },
    Suspending: class { constructor(fn) { return fn; } },
    promising: fn => fn,
  };
  try {
    const host = () => createAsyncTaskHost({});

    await t.test('cancel a running child: not physically quiescent until it stops', async () => {
      let release;
      const pending = new Promise(r => { release = r; });
      let entered = false;
      const h = host();
      h.bind({exports:{
        main: async () => 42n,
        task_invoke: async () => { entered = true; await pending; return 42n; },
      }});
      h.imports.task_start(0);
      await Promise.resolve();
      assert.equal(entered,true);
      let stopped = false;
      const drained = h.close().then(() => { stopped = true; });
      assert.equal(h.activeTaskCount,1);
      assert.equal(h.physicallyQuiescent,false);
      await Promise.resolve();
      assert.equal(stopped,false,'a cancellation request is not retirement');
      release();
      await drained;
      assert.equal(h.activeTaskCount,0);
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('cancel before dispatch: guest body never runs', async () => {
      let invoked = 0;
      const h = host();
      h.bind({exports:{
        main: async () => 42n,
        task_invoke: async () => { invoked++; return 42n; },
      }});
      h.imports.task_start(0);
      await h.close();
      assert.equal(invoked,0);
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('matched barrier must wake both waiters on close', async () => {
      const h = host();
      h.bind({exports:{main:async()=>42n,task_invoke:async()=>42n}});
      const a = h.imports.barrier(2n);
      const b = h.imports.barrier(2n);
      await h.close();
      const states = await Promise.allSettled([a,b]);
      assert.deepEqual(states.map(x=>x.status),['rejected','rejected']);
    });

    await t.test('main may not report return while detached child is running', async () => {
      let release;
      const pending = new Promise(r => { release = r; });
      const h = host();
      h.bind({exports:{
        main: async () => {
          h.imports.task_start(0);
          await Promise.resolve();
          return 42n;
        },
        task_invoke: async () => { await pending; return 42n; },
      }});
      let finished = false;
      const run = h.runMain().then(
        () => { finished = true; return 'success'; },
        () => { finished = true; return 'rejected'; }
      );
      await Promise.resolve();
      await Promise.resolve();
      assert.equal(finished,false);
      release();
      assert.equal(await run,'rejected');
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('awaited child returns int and retires before successful main', async () => {
      const h = host();
      h.bind({exports:{
        task_invoke: async () => 42n,
        main: async () => h.imports.task_await(h.imports.task_start(0)),
      }});
      assert.equal(await h.runMain(),42n);
      assert.equal(h.physicallyQuiescent,true);
    });
  } finally {
    globalThis.WebAssembly = original;
  }
});
