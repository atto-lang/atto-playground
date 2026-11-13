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
  let nextGeneration = 1;
  let fault = null, settle = null, closed = false, drainPromise = null;

  const label = a => `${a.name}#${a.ref}`;
  function terminateActor(a) {
    if (a.terminated) return; // exactly once even if close races with failure
    a.terminated = true;
    a.generation++; // revoke all callbacks before terminating
    if (!a.worker) return;
    a.worker.onmessage = a.worker.onerror = a.worker.onmessageerror = null;
    a.worker.terminate();
  }
  function fail(a, message) {
    if (closed || a.failed) return;
    a.failed = true; // terminal for this actor generation only
    if (!fault) fault = `${message} in actor ${label(a)}`;
    // Quarantine the failing worker NOW, not after healthy siblings drain.
    // Otherwise a protocol-invalid or trapped worker can keep consuming CPU.
    terminateActor(a);
    // Healthy siblings retain their own Workers/mailboxes and are drained
    // before reporting a failure. A failed actor must not block their progress.
    check();
  }
  function check() {
    if (!settle) return;
    if (actors.every(a => a.failed || (a.ready && a.done === a.sent))) {
      const resolve = settle;
      settle = null;
      resolve(fault);
    }
  }
  function appendValidatedOutput(data) {
    if (typeof data.stdout === 'string' && data.stdout) appendCapped(out, data.stdout);
    if (data.truncated === true) out.truncated = true;
  }
  function hasValidOutput(data) {
    return (data.stdout === undefined || typeof data.stdout === 'string') &&
      (data.truncated === undefined || typeof data.truncated === 'boolean');
  }
  function onMessage(a, data) {
    if (closed || a.failed) return;
    if (data?.generation !== a.generation) return; // stale actor epoch
    if (data.kind === 'ready') {
      if (a.ready || data.stdout !== undefined || data.truncated !== undefined) {
        fail(a, 'E_ACTOR_PROTOCOL: duplicate or malformed ready');
      } else {
        a.ready = true;
        check(); // zero-mail actors may now complete their sealed drain
      }
      return;
    }
    if (data.kind === 'done') {
      // Do NOT accept stdout before validating the complete mailbox ACK.
      if (!a.ready || !Number.isSafeInteger(data.sequence) ||
          data.sequence !== a.done || a.done >= a.sent || !hasValidOutput(data)) {
        fail(a, 'E_ACTOR_PROTOCOL: invalid completion');
        return;
      }
      appendValidatedOutput(data);
      a.done++;
      check();
      return;
    }
    if (data.kind === 'fault') {
      // Startup faults are allowed before ready; all other kinds must follow
      // the authenticated generation and sequence protocol.
      if (!hasValidOutput(data)) {
        fail(a, 'E_ACTOR_PROTOCOL: invalid fault output');
        return;
      }
      const message = typeof data.message === 'string' && /^E_[A-Z_]+: /.test(data.message)
        ? data.message : 'E_ACTOR: worker fault';
      appendValidatedOutput(data);
      fail(a, message);
      return;
    }
    fail(a, 'E_ACTOR_PROTOCOL: unexpected actor worker message');
  }

  function spawn(type) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    if (drainPromise) throw new Error('E_ACTOR: mailbox sealed for drain');
    if (!Number.isInteger(type) || type < 0 || type >= names.length) throw new Error('E_ACTOR: unknown actor type');
    if (actors.length >= MAX_ACTORS) throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);
    const ref = actors.length;
    const a = { ref, type, name: names[type], generation: nextGeneration++, ready: false, failed: false, terminated: false, sent: 0, done: 0, worker: null };
    try {
      a.worker = new WorkerImpl(workerUrl, { type: 'module' });
      a.worker.onmessage = event => onMessage(a, event.data);
      a.worker.onerror = event => { event?.preventDefault?.(); fail(a, 'E_ACTOR: worker failed to load or execute'); };
      a.worker.onmessageerror = () => fail(a, 'E_ACTOR_PROTOCOL: undecodable actor message');
      // Each actor gets a private copy of the module bytes. Do not admit
      // the actor into the host until the initialization transfer succeeds.
      a.worker.postMessage({ kind: 'init', wasm: new Uint8Array(wasm), type, generation: a.generation });
    } catch (error) {
      terminateActor(a); // constructor / structured-clone failure cannot leak
      throw new Error('E_ACTOR_START: failed to initialize actor worker', { cause: error });
    }
    actors.push(a);
    return ref;
  }

  function send(ref, value) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    if (drainPromise) throw new Error('E_ACTOR: mailbox sealed for drain');
    const a = Number.isInteger(ref) ? actors[ref] : undefined;
    if (!a) throw new Error('E_ACTOR: invalid actor reference');
    if (a.failed) throw new Error('E_ACTOR: target actor has failed');
    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) throw new Error('E_ACTOR: mail must be a signed 64-bit value');
    if (a.sent >= MAX_MAILBOX) throw new Error(`E_MAILBOX_FULL: actor ${label(a)} already has ${MAX_MAILBOX} messages`);
    try {
      a.worker.postMessage({ kind: 'mail', generation: a.generation, value, sequence: a.sent });
    } catch (error) {
      // Do not advance the mailbox sequence for an uncommitted send.
      // Quarantine only this worker; siblings may still complete their mail.
      fail(a, 'E_ACTOR_TRANSPORT: mailbox delivery failed');
      throw new Error('E_ACTOR_TRANSPORT: mailbox delivery failed', { cause: error });
    }
    a.sent++;
  }

  /** Resolve with null once every mailbox is drained, or with the first actor
   *  fault message. Mail can arrive only from main, so after main returns the
   *  set of messages is final. */
  function drain() {
    if (closed) return Promise.resolve('E_ACTOR_CANCELLED: actor host closed');
    if (!drainPromise) {
      drainPromise = new Promise(resolve => { settle = resolve; check(); });
    }
    return drainPromise;
  }

  function close() {
    if (closed) return;
    closed = true;
    if (settle) { const resolve = settle; settle = null; resolve('E_ACTOR_CANCELLED: actor host closed'); }
    for (const a of actors) terminateActor(a);
  }

  return { spawn, send, drain, close, get count() { return actors.length; } };
}
