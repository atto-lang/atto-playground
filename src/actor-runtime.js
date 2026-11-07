/** Host-side, bounded actor supervisor for source-free Wasm actor ABI v0.
 * Not a full AttoLang actor runtime: see docs/ACTOR_BROWSER_ABI.md.
 */
import { ACTOR_MAX_MAILBOX, ACTOR_MAX_WASM_BYTES, isI64 } from './actor-abi.js';

export async function spawnWasmActor(wasm, {
  WorkerImpl = globalThis.Worker, timeoutMs = 3000, maxMailbox = ACTOR_MAX_MAILBOX,
} = {}) {
  if (!(wasm instanceof Uint8Array) || !wasm.byteLength || wasm.byteLength > ACTOR_MAX_WASM_BYTES) {
    throw new RangeError('Actor Wasm must be 1..1048576 bytes');
  }
  if (!Number.isInteger(maxMailbox) || maxMailbox < 1 || maxMailbox > ACTOR_MAX_MAILBOX) {
    throw new RangeError('Invalid actor mailbox bound');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new RangeError('Invalid actor deadline');
  }
  if (typeof WorkerImpl !== 'function') throw new Error('Web Workers unavailable');

  const worker = new WorkerImpl(new URL('./actor-worker.js', import.meta.url), { type: 'module' });
  const pending = new Map();
  let ready = false, closed = false, nextId = 0, initTimer;
  let readyResolve, readyReject;
  const started = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });

  function terminate(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(initTimer);
    worker.onmessage = worker.onerror = worker.onmessageerror = null;
    worker.terminate();
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (!ready) readyReject(error);
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(error);
    }
    pending.clear();
  }

  worker.onmessage = ({ data }) => {
    if (closed) return;
    if (data?.kind === 'ready' && !ready) {
      ready = true;
      clearTimeout(initTimer);
      readyResolve();
      return;
    }
    if (data?.kind === 'fault') {
      terminate(new Error(typeof data.message === 'string' ? data.message : 'E_ACTOR_PANIC'));
      return;
    }
    if (data?.kind !== 'result' || !ready || !Number.isSafeInteger(data.id) || !isI64(data.value)) {
      terminate(new Error('E_ACTOR_PROTOCOL: invalid worker response'));
      return;
    }
    const task = pending.get(data.id);
    if (!task) {
      terminate(new Error('E_ACTOR_PROTOCOL: unsolicited/duplicate response'));
      return;
    }
    clearTimeout(task.timer);
    pending.delete(data.id);
    task.resolve(data.value);
  };
  worker.onerror = () => terminate(new Error('E_ACTOR_WORKER: worker failed'));
  worker.onmessageerror = () => terminate(new Error('E_ACTOR_WORKER: undecodable response'));

  initTimer = setTimeout(() => terminate(new Error('E_ACTOR_TIMEOUT: initialization deadline exceeded')), timeoutMs);
  try {
    // Do not transfer caller-owned bytes: each actor gets a private copy.
    worker.postMessage({ kind: 'init', wasm: new Uint8Array(wasm) });
  } catch (error) {
    terminate(error);
  }
  await started;

  return Object.freeze({
    send(value) {
      if (closed) return Promise.reject(new Error('E_ACTOR_CLOSED'));
      if (!isI64(value)) return Promise.reject(new TypeError('Actor messages must be signed i64 BigInt'));
      if (pending.size >= maxMailbox) return Promise.reject(new Error('E_MAILBOX_FULL'));
      if (nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(new Error('E_ACTOR_SEQUENCE_EXHAUSTED'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => terminate(new Error('E_ACTOR_TIMEOUT: receive deadline exceeded')), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { worker.postMessage({ kind: 'message', id, value }); }
        catch (error) { terminate(error); }
      });
    },
    close() { terminate(new Error('E_ACTOR_CLOSED')); },
    get closed() { return closed; },
  });
}
