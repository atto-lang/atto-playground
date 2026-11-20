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

    await t.test('consuming a Future cannot bypass active-task quota', async () => {
      let release;
      const pending = new Promise(r => { release = r; });
      const h = createAsyncTaskHost({}, {maxTasks:1});
      h.bind({exports:{
        main: async () => 42n,
        task_invoke: async () => { await pending; return 42n; },
      }});
      const handle = h.imports.task_start(0);
      await Promise.resolve();
      const observed = h.imports.task_await(handle);
      assert.equal(h.activeTaskCount,1);
      assert.throws(() => h.imports.task_start(0), /E_ASYNC: task quota exhausted/);
      release();
      assert.equal(await observed,42n);
      await h.close();
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('scope cancellation withdraws pending sleep timer immediately', async () => {
      const h = host();
      h.bind({exports:{main:async()=>42n,task_invoke:async()=>42n}});
      const sleeper = h.imports.sleep_ms(1000n);
      assert.equal(h.pendingHostWaitCount,1);
      assert.equal(h.physicallyQuiescent,false);
      const drained = h.close();
      await assert.rejects(sleeper,/E_ASYNC: task scope cancelled/);
      await drained;
      assert.equal(h.pendingHostWaitCount,0);
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('cancelled cooperation does not resume or consume yield budget', async () => {
      const h = host();
      h.bind({exports:{main:async()=>42n,task_invoke:async()=>42n}});
      const pending = h.imports.cooperate();
      assert.equal(h.pendingHostWaitCount,1);
      const drained = h.close();
      await assert.rejects(pending,/E_ASYNC: task scope cancelled/);
      await drained;
      assert.equal(h.cooperativeYields,0);
      assert.equal(h.pendingHostWaitCount,0);
    });

    await t.test('unmatched and matched barriers keep live callbacks accounted', async () => {
      const h = host();
      h.bind({exports:{main:async()=>42n,task_invoke:async()=>42n}});
      const lone = h.imports.barrier(2n);
      assert.equal(h.pendingHostWaitCount,1);
      assert.equal(h.physicallyQuiescent,false);
      const another = h.imports.barrier(2n);
      // Two unsettled waiters plus the queued handoff microtask.
      assert.equal(h.pendingHostWaitCount,3);
      const closed = h.close();
      const outcomes = await Promise.allSettled([lone,another]);
      await closed;
      assert.deepEqual(outcomes.map(x=>x.status),['rejected','rejected']);
      assert.equal(h.pendingHostWaitCount,0);
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('main suspended in timer wakes and drains promptly after close', async () => {
      const h = host();
      let started;
      const running = new Promise(resolve => { started = resolve; });
      h.bind({exports:{
        main: async () => {
          const wait = h.imports.sleep_ms(1000n);
          started();
          await wait;
          return 42n;
        },
        task_invoke:async()=>42n,
      }});
      const finishing = h.runMain();
      await running;
      assert.equal(h.pendingHostWaitCount,1);
      assert.equal(h.physicallyQuiescent,false);
      await h.close();
      await assert.rejects(finishing,/E_ASYNC: task scope cancelled/);
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('cancellation wins over a delayed successful main result', async () => {
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      const h = host();
      h.bind({exports:{
        main: async () => { await pending; return 42n; },
        task_invoke: async () => 42n,
      }});
      const result = h.runMain();
      assert.equal(h.physicallyQuiescent,false);
      const cleanup = h.close();
      release();
      await assert.rejects(result,/E_ASYNC: task scope cancelled/);
      await cleanup;
      assert.equal(h.physicallyQuiescent,true);
    });

    await t.test('matched barrier callback counts as pending until microtask drains', async () => {
      const h = host();
      h.bind({exports:{main:async()=>42n,task_invoke:async()=>42n}});
      const first = h.imports.barrier(2n);
      const second = h.imports.barrier(2n);
      const cleanup = h.close();
      assert.equal(h.pendingHostWaitCount,1,'scheduled barrier microtask remains outstanding');
      assert.equal(h.physicallyQuiescent,false,
        'rejecting waiter promises is not physical callback retirement');
      assert.deepEqual((await Promise.allSettled([first,second])).map(x=>x.status),
        ['rejected','rejected']);
      await cleanup;
      assert.equal(h.pendingHostWaitCount,0);
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
