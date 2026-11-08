/** Source -> pinned Atto Wasm compiler -> verified scalar actor guest -> Web Worker.
 * No source evaluation in JS. The current vendored compiler may lack
 * compile_actor, in which case the bridge fails closed with E_ACTOR_ABI.
 */
import { createWorkerTask } from './worker-task.js';
import { isI64, validateActorGuest } from './actor-abi.js';
import { spawnWasmActor } from './actor-runtime.js';

export class ActorCompileError extends Error {
  constructor(diagnostic) {
    const item = diagnostic && typeof diagnostic === 'object' ? diagnostic : {};
    const message = typeof item.message === 'string'
      ? item.message.slice(0, 512) : 'E_ACTOR_COMPILER: compilation failed';
    super(message);
    this.name = 'ActorCompileError';
    this.diagnostic = { line: Number.isInteger(item.line) && item.line > 0 ? item.line : 1,
      column: Number.isInteger(item.column) && item.column > 0 ? item.column : 1, message };
  }
}

export function parseActorMessage(source) {
  if (typeof source !== 'string') throw new TypeError('E_ACTOR_MESSAGE: decimal string expected');
  const s = source.trim();
  // Bound BigInt construction before allocating/parsing an adversarial integer.
  if (!/^-?(?:0|[1-9][0-9]{0,18})$/.test(s)) {
    throw new RangeError('E_ACTOR_MESSAGE: expected signed i64 decimal');
  }
  const value = BigInt(s);
  if (!isI64(value)) throw new RangeError('E_ACTOR_MESSAGE: outside signed i64 range');
  return value;
}

/** Injectable compile/spawn adapters allow deterministic race testing.
 * Default compile always uses the separate, short-lived pinned compiler worker.
 */
export function createActorSession({ compile = null, spawn = spawnWasmActor } = {}) {
  const compilerTask = createWorkerTask();
  const compileSource = compile ?? (source => compilerTask.request(
    new URL('./compiler-worker.js', import.meta.url), { kind: 'actor', source },
    10000, 'Actor compilation'
  ));
  let generation = 0, starting = false, actor = null;

  async function start(source) {
    if (starting || actor) throw new Error('E_ACTOR_ALREADY_RUNNING');
    if (typeof source !== 'string') throw new TypeError('Actor source must be text');
    starting = true;
    const id = ++generation;
    let spawned = null;
    try {
      const result = await compileSource(source);
      if (id !== generation) throw new Error('E_ACTOR_CANCELLED');
      if (!result || typeof result.ok !== 'boolean')
        throw new Error('E_ACTOR_COMPILER_PROTOCOL: invalid compiler response');
      if (!result.ok) {
        if (result.wasm !== undefined) throw new Error('E_ACTOR_COMPILER_PROTOCOL: rejected source emitted Wasm');
        throw new ActorCompileError(result.diagnostics?.[0]);
      }
      if (!(result.wasm instanceof Uint8Array)) throw new Error('E_ACTOR_COMPILER_PROTOCOL: missing actor Wasm');
      // This checks the actual exported (i64)->i64 type, import absence,
      // sections and byte budget before any worker is spawned.
      validateActorGuest(result.wasm);
      spawned = await spawn(result.wasm);
      if (id !== generation) {
        // A worker may finish initializing after Stop. Never adopt it.
        try { spawned?.close?.(); } catch { /* late worker must stay unadopted */ }
        throw new Error('E_ACTOR_CANCELLED');
      }
      if (!spawned || typeof spawned.send !== 'function' || typeof spawned.close !== 'function') {
        // Release partially initialized handles, including a worker wrapper
        // which exposes close() but lacks the mandatory send() contract.
        try { spawned?.close?.(); } catch { /* invalid handle is never adopted */ }
        throw new Error('E_ACTOR_PROTOCOL: invalid actor handle');
      }
      actor = spawned;
      return { wasm: result.wasm };
    } finally {
      if (id === generation) starting = false;
    }
  }

  function stop() {
    ++generation;
    compilerTask.cancel();
    const closing = actor;
    // Invalidate state before calling external close(): a malicious/faulty
    // injected handle cannot keep this session active or prevent restart.
    actor = null;
    starting = false;
    try { closing?.close(); } catch { /* stop remains terminal and idempotent */ }
  }
  return Object.freeze({
    start,
    send(value) {
      if (!actor || actor.closed) return Promise.reject(new Error('E_ACTOR_CLOSED'));
      if (!isI64(value)) return Promise.reject(new TypeError('E_ACTOR_MESSAGE: signed i64 required'));
      return actor.send(value);
    },
    stop,
    get active() { return Boolean(actor && !actor.closed); },
    get starting() { return starting; },
  });
}
