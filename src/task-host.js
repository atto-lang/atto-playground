/** Native guest Wasm JSPI bridge for experimental atto.async/2.
 * Task bodies run in WebAssembly, never in dynamically evaluated JavaScript.
 * Every task has one owning scope and a single-consumption Future<int> handle.
 * This first slice requires browser JSPI; no eager/sync task fallback. */
export const MAX_TASKS = 64;
const ASYNC_NAMES = new Set(['sleep_ms', 'barrier', 'task_start', 'task_await', 'cooperate']);

export function asyncGuestInfo(module) {
  const sections = WebAssembly.Module.customSections(module, 'atto.async');
  const imp = WebAssembly.Module.imports(module);
  const exp = WebAssembly.Module.exports(module);
  const hasTaskStart = imp.some(x => x.module === 'atto' && x.name === 'task_start');
  const hasInvoke = exp.some(x => x.name === 'task_invoke' && x.kind === 'function');
  const usesAsync = imp.some(x => ASYNC_NAMES.has(x.name));
  if (!sections.length) {
    if (usesAsync || hasInvoke) throw Error('E_ASYNC: unmarked guest async capability');
    return { enabled: false };
  }
  if (sections.length !== 1 || new Uint8Array(sections[0]).length !== 1 || new Uint8Array(sections[0])[0] !== 2) {
    throw Error('E_ASYNC: unsupported or duplicated guest async ABI');
  }
  if (!usesAsync || hasTaskStart !== hasInvoke || exp.some(x => x.name === 'task_invoke' && x.kind !== 'function')) {
    throw Error('E_ASYNC: inconsistent async imports and task exports');
  }
  // Actor-enabled modules are allowed only when each actor runs its own
  // separately-instantiated Wasm module inside a dedicated actor Worker.
  // The runner's task host never executes actor_receive or actor task bodies.
  return { enabled: true };
}

export function createAsyncTaskHost(module, { maxTasks = MAX_TASKS, maxYields = 16384, jspi = WebAssembly } = {}) {
  if (!asyncGuestInfo(module).enabled) throw Error('E_ASYNC: missing opt-in ABI');
  if (typeof jspi.Suspending !== 'function' || typeof jspi.promising !== 'function') {
    throw Error('E_ASYNC: this browser does not implement native Wasm JSPI');
  }
  if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > MAX_TASKS) throw Error('E_ASYNC: task quota invalid');
  let instance = null;
  let closed = false;
  let next = 1;
  let cooperativeYields = 0;
  let handlerActive = false;
  let scopeGeneration = 1;
  if (!Number.isInteger(maxYields) || maxYields < 1 || maxYields > 65536) throw Error('E_ASYNC: invalid yield quota');
  const jobs = new Map(); // handles not yet consumed by await
  const allTasks = new Set(); // includes consumed handles until settled
  const barrierWaiters = new Set(); // includes matched, not-yet-resumed waiters
  let pendingBarrier = [];
  const stop = error => {
    if (closed) return;
    closed = true;
    scopeGeneration++;
    for (const task of [...allTasks]) task.reject(error);
    jobs.clear();
    allTasks.clear();
    for (const waiter of [...barrierWaiters]) waiter.reject(error);
    barrierWaiters.clear();
    pendingBarrier = [];
  };
  const ensureOpen = () => {
    if (closed || !instance) throw Error('E_ASYNC: task scope closed or unbound');
  };
  const checkInt = (n, lo, hi, label) => {
    if (typeof n !== 'bigint' || n < BigInt(lo) || n > BigInt(hi)) {
      throw Error('E_ASYNC: invalid ' + label);
    }
    return Number(n);
  };
  // A language-level await ALWAYS hands the worker carrier back to the
  // scheduler for a new browser event-loop turn. Even an already-ready scalar
  // or Future must never take a synchronous/Promise.resolve fast path.
  const cooperate = new jspi.Suspending(async () => {
    ensureOpen();
    const generation = scopeGeneration;
    if (cooperativeYields >= maxYields) throw Error('E_ASYNC: cooperative yield quota exhausted');
    await new Promise(resolve => setTimeout(resolve, 0));
    ensureOpen();
    if (generation !== scopeGeneration) throw Error('E_ASYNC: stale cooperative continuation');
    cooperativeYields += 1;
  });
  const sleep_ms = new jspi.Suspending(async n => {
    ensureOpen();
    const ms = checkInt(n, 0, 1000, 'sleep duration');
    const generation = scopeGeneration;
    await new Promise(resolve => setTimeout(resolve, ms));
    ensureOpen();
    if (generation !== scopeGeneration) throw Error('E_ASYNC: stale timer continuation');
    return 0n;
  });
  const barrier = new jspi.Suspending(async n => {
    ensureOpen();
    checkInt(n, 2, 2, 'barrier parties');
    const generation = scopeGeneration;
    const value = await new Promise((resolve, reject) => {
      const waiter = {
        settled: false,
        resolve(result) {
          if (this.settled) return;
          this.settled = true;
          barrierWaiters.delete(this);
          resolve(result);
        },
        reject(error) {
          if (this.settled) return;
          this.settled = true;
          barrierWaiters.delete(this);
          reject(error);
        },
      };
      barrierWaiters.add(waiter);
      pendingBarrier.push(waiter);
      if (pendingBarrier.length === 2) {
        const pair = pendingBarrier;
        pendingBarrier = [];
        // Both continuations must remain cancellable between pairing and
        // scheduling. Never strand them if the scope closes in this window.
        queueMicrotask(() => {
          if (closed || generation !== scopeGeneration) {
            pair.forEach(w => w.reject(Error('E_ASYNC: barrier scope cancelled')));
          } else {
            pair.forEach(w => w.resolve(0n));
          }
        });
      }
    });
    ensureOpen();
    if (generation !== scopeGeneration) throw Error('E_ASYNC: stale barrier continuation');
    return value;
  });
  const task_start = index => {
    ensureOpen();
    if (!Number.isInteger(index) || index < 0 || index > 1024) throw Error('E_ASYNC: invalid task index');
    if (allTasks.size >= maxTasks || next === 0x7fffffff) throw Error('E_ASYNC: task quota exhausted');
    const handle = next++;
    const generation = scopeGeneration;
    const task = { consumed: false, settled: false };
    task.promise = new Promise((resolve, reject) => {
      const settle = (ok, value) => {
        if (task.settled) return;
        task.settled = true;
        if (task.consumed) allTasks.delete(task);
        if (ok) resolve(value); else reject(value);
      };
      task.resolve = value => settle(true, value);
      task.reject = error => settle(false, error);
    });
    allTasks.add(task);
    // Spawned work may fail before awaiting; suppress *unhandled* notices while
    // keeping the exact rejection observable through the owning Future handle.
    task.promise.catch(() => {});
    jobs.set(handle, task);
    queueMicrotask(async () => {
      if (closed || generation !== scopeGeneration) return; // stop already rejected it
      try {
        const invoke = jspi.promising(instance.exports.task_invoke);
        const result = await invoke(index);
        if (closed || generation !== scopeGeneration) return;
        if (typeof result !== 'bigint') throw Error('E_ASYNC: task returned non-int value');
        task.resolve(result);
      } catch (error) { task.reject(error); }
    });
    return handle;
  };
  const task_await = new jspi.Suspending(async handle => {
    ensureOpen();
    const task = jobs.get(handle);
    if (!task || task.consumed) throw Error('E_ASYNC: forged or already-consumed future handle');
    const generation = scopeGeneration;
    task.consumed = true;
    jobs.delete(handle);
    if (task.settled) allTasks.delete(task);
    const result = await task.promise;
    ensureOpen();
    if (generation !== scopeGeneration) throw Error('E_ASYNC: stale future continuation');
    return result;
  });
  return {
    imports: Object.freeze({ sleep_ms, barrier, task_start, task_await, cooperate }),
    get cooperativeYields() { return cooperativeYields; },
    bind(wasm) { if (instance) throw Error('E_ASYNC: cannot rebind task scope'); instance = wasm; },
    async runActorReceive(type, value, sequence) {
      ensureOpen();
      if (handlerActive) throw Error('E_ACTOR_REENTRANT: actor mailbox handler already active');
      if (typeof value !== 'bigint' || typeof sequence !== 'bigint') throw Error('E_ACTOR: invalid mail ABI');
      if (!Number.isInteger(type) || type < 0) throw Error('E_ACTOR: invalid actor type');
      if (typeof instance.exports.actor_receive !== 'function') throw Error('E_ACTOR: no receive entrypoint');
      const generation = scopeGeneration;
      handlerActive = true;
      try {
        const done = await jspi.promising(instance.exports.actor_receive)(type, value, sequence);
        ensureOpen();
        if (generation !== scopeGeneration) throw Error('E_ACTOR_STALE: handler resumed after cancellation');
        if (done !== undefined) throw Error('E_ACTOR: receive unexpectedly returned a value');
        if (allTasks.size) throw Error('E_ACTOR_TASK_LEAK: child task scope not drained');
      } catch (error) {
        // Failed handlers poison the actor's task scope: no stale task may
        // mutate this actor again, and sibling actors retain their Workers.
        stop(Error('E_ACTOR_CANCELLED: handler failed'));
        throw error;
      } finally {
        handlerActive = false;
      }
    },
    async runMain() {
      ensureOpen();
      try {
        const result = await jspi.promising(instance.exports.main)();
        if (typeof result !== 'bigint') throw Error('E_ASYNC: main did not return int');
        if (allTasks.size) throw Error('E_ASYNC: detached task or unawaited Future<int>');
        return result;
      } finally { stop(Error('E_ASYNC: task scope exited')); }
    },
    close() { stop(Error('E_ASYNC: task scope cancelled')); },
  };
}
