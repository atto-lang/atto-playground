// Deterministic, source-runtime cancellation race stress (mocked JSPI).
// No compiler .atto guest, no lock unwind and no TenantVM certification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAsyncTaskHost } from '../src/task-host.js';

test('400 cancel/success and matched barrier scheduling races preserve retirement', async () => {
  const original = globalThis.WebAssembly;
  globalThis.WebAssembly = {
    Module: {
      customSections: (_, name) => name === 'atto.async' ? [Uint8Array.of(2).buffer] : [],
      imports: () => [{module: 'atto', name: 'task_start'}],
      exports: () => [{name: 'task_invoke', kind: 'function'}],
    },
    Suspending: class { constructor(fn) { return fn; } },
    promising: fn => fn,
  };
  try {
    const host = () => createAsyncTaskHost({});
    for (let i = 0; i < 200; i++) {
      let release;
      const pending = new Promise(resolve => { release = resolve; });
      const h = host();
      h.bind({exports:{
        main: async () => { await pending; return 42n; },
        task_invoke: async () => 42n,
      }});
      const task = h.runMain();
      if (i % 2 === 0) {
        // Cancellation wins before guest completion; no fabricated T.
        const drained = h.close();
        release();
        await assert.rejects(task, /E_ASYNC: task scope cancelled/);
        await drained;
      } else {
        // The successful terminal result commits before late cancellation.
        release();
        assert.equal(await task, 42n);
        await h.close();
      }
      assert.equal(h.physicallyQuiescent,true,`main race ${i}`);
    }
    for (let i = 0; i < 200; i++) {
      const h = host();
      h.bind({exports:{main:async()=>42n, task_invoke:async()=>42n}});
      const first = h.imports.barrier(2n);
      const second = h.imports.barrier(2n);
      if (i % 2 === 0) {
        // A matched wake is queued, but not actually retired.
        const drained = h.close();
        assert.equal(h.physicallyQuiescent,false);
        assert.deepEqual((await Promise.allSettled([first,second]))
          .map(result => result.status), ['rejected','rejected']);
        await drained;
      } else {
        assert.deepEqual(await Promise.all([first,second]), [0n,0n]);
        await h.close();
      }
      assert.equal(h.pendingHostWaitCount,0,`barrier race ${i}`);
      assert.equal(h.physicallyQuiescent,true,`barrier race ${i}`);
    }
  } finally {
    globalThis.WebAssembly = original;
  }
});
