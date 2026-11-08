/** Actor host for guest contract atto.browser.guest.v2.
 *
 * Every `spawn` starts one dedicated Web Worker running src/actor-worker.js
 * with its own instance of the program's module, so actor state (instance
 * globals) is never shared. `send` posts mail in FIFO order with sequence
 * numbers from 0. The host lives inside the runner worker: terminating the
 * runner (Stop or the run deadline) also ends every actor worker it owns.
 */
import { appendCapped } from './guest.js';

export const MAX_ACTORS = 16;
export const MAX_MAILBOX = 10_000;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

export function createActorHost({ wasm, names, out, WorkerImpl = globalThis.Worker,
  workerUrl = new URL('./actor-worker.js', import.meta.url) }) {
  if (!(wasm instanceof Uint8Array)) throw new TypeError('actor host needs the guest bytes');
  if (!Array.isArray(names) || !names.length) throw new Error('actor host needs an actor table');
  const actors = [];
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
      check();
    } else if (data?.kind === 'ready' && !a.ready) {
      a.ready = true;
      check();
    } else {
      fail(a, 'E_ACTOR_PROTOCOL: unexpected actor worker message');
    }
  }

  function spawn(type) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    if (!Number.isInteger(type) || type < 0 || type >= names.length) throw new Error('E_ACTOR: unknown actor type');
    if (actors.length >= MAX_ACTORS) throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);
    const ref = actors.length;
    const a = { ref, type, name: names[type], sent: 0, done: 0, ready: false, worker: null };
    a.worker = new WorkerImpl(workerUrl, { type: 'module' });
    if (!a.worker || workerIdentities.has(a.worker)) {
      // A mock or host adapter must never assign two actor identities to one Worker.
      fail(a, 'E_ACTOR_ISOLATION: duplicate worker identity');
      throw new Error(fault);
    }
    workerIdentities.add(a.worker);
    try {
      a.worker.onmessage = event => onMessage(a, event.data);
      a.worker.onerror = event => { event?.preventDefault?.(); fail(a, 'E_ACTOR: worker failed to load or execute'); };
      a.worker.onmessageerror = () => fail(a, 'E_ACTOR_PROTOCOL: undecodable actor message');
      // Each actor receives a distinct copy and a distinct Worker identity.
      a.worker.postMessage({ kind: 'init', wasm: new Uint8Array(wasm), type });
      actors.push(a);
      return ref;
    } catch (error) {
      try {
        a.worker.onmessage = a.worker.onerror = a.worker.onmessageerror = null;
        a.worker.terminate();
      } catch { /* The host must still fail instead of admitting this actor. */ }
      workerIdentities.delete(a.worker);
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
    try {
      a.worker.postMessage({ kind: 'mail', value, sequence: a.sent });
      a.sent++;
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
      try {
        a.worker.onmessage = a.worker.onerror = a.worker.onmessageerror = null;
        a.worker.terminate();
      } catch { /* Continue cleanup of all remaining actor workers. */ }
    }
    workerIdentities.clear();
  }

  return { spawn, send, drain, close, get count() { return actors.length; } };
}
