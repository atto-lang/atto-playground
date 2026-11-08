/** Actor host for guest contract atto.browser.guest.v2.
 *
 * Every `spawn` starts one dedicated Web Worker running src/actor-worker.js
 * with its own instance of the program's module, so actor state (instance
 * globals) is never shared. `send` posts mail in FIFO order with sequence
 * numbers from 0. The host lives inside the runner worker: terminating the
 * runner (Stop or the run deadline) also ends every actor worker it owns.
 */
import { appendCapped } from './guest.js';

export const MAX_TOTAL_PENDING_MESSAGES = 20_000;
export const MAX_SINGLE_ACTOR_MEMORY_BYTES = 1 * 1024 * 1024;
export const MAX_TOTAL_ACTOR_MEMORY_BYTES = 8 * 1024 * 1024;
export const MAX_ACTOR_INIT_MS = 5_000;
const WASM_PAGE_BYTES = 65_536;
const MAX_GUEST_MEMORY_PAGES = 16;

function readUleb(bytes, state, end) {
  let value = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    if (state.pos >= end) throw new Error('E_ACTOR_MEMORY_POLICY: truncated Wasm section');
    const byte = bytes[state.pos++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) {
      if (value > 0xffffffff) throw new Error('E_ACTOR_MEMORY_POLICY: Wasm integer overflow');
      return value;
    }
    shift += 7;
  }
  throw new Error('E_ACTOR_MEMORY_POLICY: malformed Wasm integer');
}

/** Reserve the declared maximum of the guest's fixed memory, never just its
 * current minimum. The browser compiler emits at most one non-growable 16-page
 * memory; rejecting other shapes makes accounting deterministic. */
export function guestMemoryBudgetBytes(wasm) {
  if (!(wasm instanceof Uint8Array) || wasm.length < 8 ||
      wasm[0] !== 0 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d ||
      wasm[4] !== 1 || wasm[5] !== 0 || wasm[6] !== 0 || wasm[7] !== 0) {
    throw new Error('E_ACTOR_MEMORY_POLICY: invalid Wasm header');
  }
  const state = { pos: 8 };
  let memorySectionSeen = false, budget = 0;
  while (state.pos < wasm.length) {
    const id = wasm[state.pos++];
    const size = readUleb(wasm, state, wasm.length);
    const end = state.pos + size;
    if (end > wasm.length) throw new Error('E_ACTOR_MEMORY_POLICY: section exceeds module');
    if (id === 5) {
      if (memorySectionSeen) throw new Error('E_ACTOR_MEMORY_POLICY: duplicate memory section');
      memorySectionSeen = true;
      const count = readUleb(wasm, state, end);
      if (count > 1) throw new Error('E_ACTOR_MEMORY_POLICY: multiple guest memories unsupported');
      if (count === 1) {
        const flags = readUleb(wasm, state, end);
        if (flags !== 1) throw new Error('E_ACTOR_MEMORY_POLICY: memory must have a fixed maximum');
        const min = readUleb(wasm, state, end);
        const max = readUleb(wasm, state, end);
        if (min !== max || max > MAX_GUEST_MEMORY_PAGES) {
          throw new Error('E_ACTOR_MEMORY_POLICY: memory must be fixed and at most 16 pages');
        }
        budget = max * WASM_PAGE_BYTES;
      }
      if (state.pos !== end) throw new Error('E_ACTOR_MEMORY_POLICY: malformed memory section');
    }
    state.pos = end;
  }
  if (budget > MAX_SINGLE_ACTOR_MEMORY_BYTES) throw new Error('E_ACTOR_MEMORY_POLICY: actor memory exceeds 1 MiB');
  return budget;
}

export const MAX_ACTORS = 16;
export const MAX_MAILBOX = 10_000;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

export function createActorHost({ wasm, names, out, WorkerImpl = globalThis.Worker,
  workerUrl = new URL('./actor-worker.js', import.meta.url),
  initTimeoutMs = MAX_ACTOR_INIT_MS,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
  if (!(wasm instanceof Uint8Array)) throw new TypeError('actor host needs the guest bytes');
  if (!Array.isArray(names) || !names.length) throw new Error('actor host needs an actor table');
  if (!Number.isSafeInteger(initTimeoutMs) || initTimeoutMs <= 0 || typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw new TypeError('invalid actor init timeout configuration');
  const actorMemoryBytesPerInstance = guestMemoryBudgetBytes(wasm);
  const actors = [];
  let actorMemoryBytes = 0, pendingMessages = 0;
  let fault = null, closed = false, terminal = false, terminalResult = null;
  const drainWaiters = [];
  const workerIdentities = new Set();

  const label = a => `${a.name}#${a.ref}`;
  function fail(a, message) {
    if (fault) return;
    fault = `${message} in actor ${label(a)}`;
    check();
  }
  function check() {
    if (!drainWaiters.length) return;
    if (terminal) {
      const waiters = drainWaiters.splice(0);
      for (const resolve of waiters) resolve(terminalResult);
      return;
    }
    if (fault || closed || actors.every(a => a.ready && a.done === a.sent)) {
      terminalResult = fault || (closed ? 'E_ACTOR_CANCELLED: actor host closed' : null);
      terminal = true;
      const waiters = drainWaiters.splice(0);
      for (const resolve of waiters) resolve(terminalResult);
    }
  }
  function onMessage(a, data) {
    if (closed || fault) return;
    if (typeof data?.stdout === 'string' && data.stdout) appendCapped(out, data.stdout);
    if (data?.truncated) out.truncated = true;
    if (data?.kind === 'fault') {
      fail(a, typeof data.message === 'string' && /^E_[A-Z_]+: /.test(data.message) ? data.message : 'E_ACTOR: worker fault');
    } else if (data?.kind === 'done' && a.ready && data.sequence === a.done && a.done < a.sent) {
      a.done++;
      pendingMessages--;
      check();
    } else if (data?.kind === 'ready' && !a.ready) {
      a.ready = true;
      if (a.initTimer !== null) { clearTimer(a.initTimer); a.initTimer = null; }
      check();
    } else {
      fail(a, 'E_ACTOR_PROTOCOL: unexpected actor worker message');
    }
  }

  function spawn(type) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    if (!Number.isInteger(type) || type < 0 || type >= names.length) throw new Error('E_ACTOR: unknown actor type');
    if (actors.length >= MAX_ACTORS) throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);
    if (actorMemoryBytes + actorMemoryBytesPerInstance > MAX_TOTAL_ACTOR_MEMORY_BYTES) throw new Error('E_ACTOR_TOTAL_MEMORY: aggregate actor memory budget exceeded');
    const ref = actors.length;
    const a = { ref, type, name: names[type], sent: 0, done: 0, ready: false, worker: null, initTimer: null };
    let ownsWorker = false;
    actorMemoryBytes += actorMemoryBytesPerInstance;
    try {
      a.worker = new WorkerImpl(workerUrl, { type: 'module' });
    if (!a.worker) throw new Error('Worker constructor returned no worker');
      if (!a.worker || workerIdentities.has(a.worker)) {
      // A mock or host adapter must never assign two actor identities to one Worker.
        fail(a, 'E_ACTOR_ISOLATION: duplicate worker identity');
        throw new Error(fault);
      }
      workerIdentities.add(a.worker);
      ownsWorker = true;
      a.worker.onmessage = event => onMessage(a, event.data);
      a.worker.onerror = event => { event?.preventDefault?.(); fail(a, 'E_ACTOR: worker failed to load or execute'); };
      a.worker.onmessageerror = () => fail(a, 'E_ACTOR_PROTOCOL: undecodable actor message');
      a.initTimer = setTimer(() => {
        if (!a.ready && !closed) fail(a, 'E_ACTOR_INIT_TIMEOUT: actor worker did not become ready');
      }, initTimeoutMs);
      // Each actor receives a distinct copy and a distinct Worker identity.
      a.worker.postMessage({ kind: 'init', wasm: new Uint8Array(wasm), type });
      actors.push(a);
      return ref;
    } catch (error) {
      if (a.initTimer !== null) { clearTimer(a.initTimer); a.initTimer = null; }
      try {
        if (ownsWorker && a.worker) {
          a.worker.onmessage = a.worker.onerror = a.worker.onmessageerror = null;
          a.worker.terminate();
        }
      } catch { /* The host must still fail instead of admitting this actor. */ }
      if (ownsWorker && a.worker) workerIdentities.delete(a.worker);
      actorMemoryBytes -= actorMemoryBytesPerInstance;
      fail(a, 'E_ACTOR_INIT: worker initialization failed');
      throw error;
    }
  }

  function send(ref, value) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    const a = Number.isInteger(ref) ? actors[ref] : undefined;
    if (!a) throw new Error('E_ACTOR: invalid actor reference');
    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) throw new Error('E_ACTOR: mail must be a signed 64-bit value');
    if (a.sent >= MAX_MAILBOX) throw new Error(`E_MAILBOX_FULL: actor ${label(a)} already has ${MAX_MAILBOX} messages`);
    if (pendingMessages >= MAX_TOTAL_PENDING_MESSAGES) throw new Error('E_ACTOR_TOTAL_MAILBOX: aggregate pending-message budget exceeded');
    try {
      a.worker.postMessage({ kind: 'mail', value, sequence: a.sent });
      a.sent++;
      pendingMessages++;
    } catch (error) {
      fail(a, 'E_ACTOR_SEND: worker refused message');
      throw error;
    }
  }

  /** Resolve with null once every mailbox is drained, or with the first actor
   *  fault message. Mail can arrive only from main, so after main returns the
   *  set of messages is final. */
  function drain() {
    if (terminal) return Promise.resolve(terminalResult);
    return new Promise(resolve => { drainWaiters.push(resolve); check(); });
  }

  function close() {
    if (closed) return;
    closed = true;
    // Preserve a completed successful drain; only cancel work that is still pending.
    if (!terminal && !fault) fault = 'E_ACTOR_CANCELLED: actor host closed';
    check(); // settle every pending drain; never leave a cancelled run hanging
    for (const a of actors) {
      if (a.initTimer !== null) { clearTimer(a.initTimer); a.initTimer = null; }
      try {
        a.worker.onmessage = a.worker.onerror = a.worker.onmessageerror = null;
        a.worker.terminate();
      } catch { /* Continue cleanup of all remaining actor workers. */ }
    }
    workerIdentities.clear();
    actorMemoryBytes = 0;
    pendingMessages = 0;
  }

  return { spawn, send, drain, close,
    get count() { return actors.length; },
    get stats() { return Object.freeze({ actors: actors.length, actorMemoryBytes, pendingMessages, maxActorMemoryBytes: MAX_TOTAL_ACTOR_MEMORY_BYTES, maxPendingMessages: MAX_TOTAL_PENDING_MESSAGES }); }
  };
}
