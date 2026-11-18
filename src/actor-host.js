/** Actor host for guest contract atto.browser.guest.v2.
 *
 * Every `spawn` starts one dedicated Web Worker running src/actor-worker.js
 * with its own instance of the program's module, so actor state (instance
 * globals) is never shared. `send` posts mail in FIFO order with sequence
 * numbers from 0. The host lives inside the runner worker: terminating the
 * runner (Stop or the run deadline) also ends every actor worker it owns.
 */
import { createLocalActorRegistry } from './local-actor-registry.js';
import { createLocalActorGroups, createLocalPubSub } from './local-actor-groups.js';
import { appendCapped } from './guest.js';

export const MAX_ACTORS = 16;
export const MAX_MAILBOX = 10_000;
const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n;

export function createActorHost({ wasm, names, out, WorkerImpl = globalThis.Worker,
  workerUrl = new URL('./actor-worker.js', import.meta.url) }) {
  if (!(wasm instanceof Uint8Array)) throw new TypeError('actor host needs the guest bytes');
  if (!Array.isArray(names) || !names.length) throw new Error('actor host needs an actor table');
  const actors = [];
  let fault = null, settle = null, closed = false, draining = false, admissionClosed = false;

  const label = a => `${a.name}#${a.ref}`;
  function terminate(a) {
    if (a.terminated) return;
    a.terminated = true;
    a.worker.onmessage = a.worker.onerror = a.worker.onmessageerror = null;
    a.worker.terminate();
  }
  function fail(a, message) {
    if (closed || a.failed) return;
    a.failed = true;
    // Preserve the first diagnostic, but do not suppress healthy siblings.
    if (!fault) fault = `${message} in actor ${label(a)}`;
    terminate(a); // faulted actors must not retain their mailbox or heap
    check();
  }
  function check() {
    if (!settle) return;
    // A fault is terminal for its own actor only. All healthy actors must
    // finish their admitted mail, and startup must succeed even with no mail.
    if (closed || actors.every(a => a.failed || (a.ready && a.done === a.sent))) {
      const resolve = settle;
      settle = null;
      draining = false;
      resolve(closed ? (fault || 'E_ACTOR: actor host closed') : fault);
    }
  }
  function onMessage(a, data) {
    if (closed || a.failed) return;
    if (typeof data?.stdout === 'string' && data.stdout) appendCapped(out, data.stdout);
    if (data?.truncated) out.truncated = true;
    if (data?.kind === 'fault') {
      fail(a, typeof data.message === 'string' && /^E_[A-Z_]+: /.test(data.message) ? data.message : 'E_ACTOR: worker fault');
    } else if (data?.kind === 'ready' && !a.ready) {
      a.ready = true;
      check();
    } else if (data?.kind === 'done' && a.ready && data.sequence === a.done && a.done < a.sent) {
      a.done++;
      check();
    } else {
      fail(a, 'E_ACTOR_PROTOCOL: unexpected actor worker message');
    }
  }

  function spawn(type) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    if (admissionClosed) throw new Error('E_ACTOR: spawn admission closed after main returned');
    if (!Number.isInteger(type) || type < 0 || type >= names.length) throw new Error('E_ACTOR: unknown actor type');
    if (actors.length >= MAX_ACTORS) throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);
    const ref = actors.length;
    const a = { ref, type, name: names[type], sent: 0, done: 0, ready: false, failed: false, terminated: false, worker: null };
    try {
      a.worker = new WorkerImpl(workerUrl, { type: 'module' });
      a.worker.onmessage = event => onMessage(a, event.data);
      a.worker.onerror = event => { event?.preventDefault?.(); fail(a, 'E_ACTOR: worker failed to load or execute'); };
      a.worker.onmessageerror = () => fail(a, 'E_ACTOR_PROTOCOL: undecodable actor message');
      // Each actor gets a private copy of the module bytes.
      a.worker.postMessage({ kind: 'init', wasm: new Uint8Array(wasm), type });
    } catch (error) {
      // Failed initialization admission cannot leave an orphaned Worker.
      // Do not consume an actor slot if the constructor or postMessage fails.
      if (a.worker) terminate(a);
      throw error;
    }
    actors.push(a);
    return ref;
  }

  function send(ref, value) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    const a = Number.isInteger(ref) ? actors[ref] : undefined;
    if (!a) throw new Error('E_ACTOR: invalid actor reference');
    // Preserve the terminal actor reason even after global admission closes.
    if (a.failed) throw new Error(`E_ACTOR_DEAD: actor ${label(a)} terminated`);
    if (admissionClosed) throw new Error('E_ACTOR: mailbox admission closed after main returned');
    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) throw new Error('E_ACTOR: mail must be a signed 64-bit value');
    if (a.sent >= MAX_MAILBOX) throw new Error(`E_MAILBOX_FULL: actor ${label(a)} already has ${MAX_MAILBOX} messages`);
    a.worker.postMessage({ kind: 'mail', value, sequence: a.sent });
    a.sent++;
  }

  function isLive(ref) {
    const actor = Number.isInteger(ref) ? actors[ref] : undefined;
    return !closed && !!actor && !actor.failed && !actor.terminated;
  }

  function retire(ref) {
    if (!isLive(ref)) return false;
    const actor = actors[ref];
    actor.failed = true; // terminal without creating a global run fault
    terminate(actor);
    check();
    return true;
  }

  /** Resolve after all healthy actors drain and every actor has finished
   *  startup (or failed). Preserve the first fault while siblings continue.
   *  Mail comes only from main, so after main returns it is final. */
  function drain() {
    if (closed) return Promise.resolve('E_ACTOR: actor host closed');
    if (draining) throw new Error('E_ACTOR_PROTOCOL: concurrent drains');
    // No new messages after drain starts: otherwise termination detection can
    // race with a producer extending a mailbox after the last completion.
    admissionClosed = true;
    draining = true;
    return new Promise(resolve => { settle = resolve; check(); });
  }

  function close() {
    if (closed) return;
    closed = true;
    groups.close();
    registry.close();
    for (const a of actors) terminate(a);
    // Explicit shutdown must settle an outstanding drain, never hang callers.
    check();
  }

  function getOrCreate(type, namespace, applicationKey) {
    const ref = registry.get_or_create({
      namespace, actor_type: type, application_key: applicationKey
    });
    // Exact physical incarnation, not a virtual ref, for existing i32 ABI.
    return registry.slot_for(ref);
  }

  const registry = createLocalActorRegistry({ names, spawn, send, isLive, retire });
  const groups = createLocalActorGroups({ registry });
  const pubsub = createLocalPubSub(groups);
  return { spawn, send, getOrCreate, drain, close, isLive, retire, registry, groups, pubsub,
    get count() { return actors.length; } };
}
