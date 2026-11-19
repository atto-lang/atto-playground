/** Tenant-local actor scheduler for guest ABI atto.browser.guest.v2.
 *
 * Runs inside the existing disposable runner Worker. Every actor gets an
 * independent WebAssembly.Instance of the SAME compiled module, including
 * its own linear memory (when the guest declares one) and mutable globals.
 * No actor Web Workers or raw cross-actor pointers are created.
 *
 * This is intentionally a synchronous-mail ABI: only main() can spawn/send,
 * and receive() executes to completion before the next actor is scheduled.
 * There is NO preemption inside a guest call yet. The outer runner deadline
 * must terminate the tenant worker if a guest loops forever.
 */
import { createLocalActorRegistry } from './local-actor-registry.js';
import { createLocalActorGroups, createLocalPubSub } from './local-actor-groups.js';
import { createLocalActorJobRouter } from './local-actor-job-router.js';
import { appendCapped, describePanic, guestImports } from './guest.js';
import { MAX_ACTORS, MAX_MAILBOX } from './actor-host.js';

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const MAX_MEMORY_BYTES = 1 << 20;
// Aggregate outstanding mail budget; scoped to the disposable tenant.
export const MAX_TOTAL_PENDING_MESSAGES = 20_000;
const YIELD_EVERY = 64;

export function createTenantActorHost({ module, names, out }) {
  if (!(module instanceof WebAssembly.Module)) throw new TypeError('compiled Wasm module required');
  if (!Array.isArray(names) || !names.length) throw new Error('actor table required');
  if (!out || typeof out.text !== 'string') throw new TypeError('stdout accumulator required');

  const actors = [];
  let fault = null;
  let closed = false;
  let draining = false;
  let admissionClosed = false;
  let pendingMessages = 0, droppedMessages = 0;

  function label(a) { return `${a.name}#${a.ref}`; }
  function flush(a) {
    if (a.output.text) appendCapped(out, a.output.text);
    if (a.output.truncated) out.truncated = true;
    a.output.text = '';
    a.output.truncated = false;
  }
  function failed(a, error) {
    if (!fault) {
      const description = a.instance
        ? describePanic(a.instance, error)
        : /^E_[A-Z_]+: /.test(error?.message ?? '') ? error.message : `E_ACTOR: ${error?.message ?? 'unknown failure'}`;
      fault = `${description} in actor ${label(a)}`;
    }
    a.failed = true;
    const lost = a.mailbox.length - a.head;
    pendingMessages -= lost;
    droppedMessages += lost;
    for (let i = a.head; i < a.mailbox.length; i++) {
      const item = a.mailbox[i];
      if (item?.mailbox_claim) jobs.observe_job(item.mailbox_claim, a.ref, 'lost');
    }
    flush(a);
    // A trapped/failed actor may have allocated guest linear memory.
    // Never retain it as an inactive keyed activation.
    a.mailbox.length = 0;
    a.head = 0;
    a.instance = null;
  }
  function checkMemory(a) {
    const memory = a.instance?.exports.memory;
    // Older pinned scalar-only actor artifacts export no memory. They have
    // private instance globals but no guest linear heap. New compiler builds
    // export a private bounded memory for every actor-bearing module.
    if (memory !== undefined && (!(memory instanceof WebAssembly.Memory) ||
        memory.buffer.byteLength > MAX_MEMORY_BYTES)) {
      throw new Error('E_ACTOR_MEMORY: actor linear memory exceeds 1 MiB');
    }
  }

  function spawn(type) {
    if (closed) throw new Error('E_ACTOR: tenant closed');
    if (admissionClosed) throw new Error('E_ACTOR: spawn admission closed after main returned');
    if (!Number.isInteger(type) || type < 0 || type >= names.length) throw new Error('E_ACTOR: unknown actor type');
    if (actors.length >= MAX_ACTORS) throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);

    const a = {
      ref: actors.length, type, name: names[type], instance: null,
      output: { text: '', truncated: false }, mailbox: [], head: 0,
      sent: 0, failed: false
    };
    actors.push(a);
    try {
      const host = guestImports(module, a.output);
      a.instance = new WebAssembly.Instance(module, host.imports);
      host.bind(a.instance);
      if (typeof a.instance.exports.actor_init !== 'function' ||
          typeof a.instance.exports.actor_receive !== 'function') {
        throw new Error('E_ACTOR_PROTOCOL: actor exports missing');
      }
      checkMemory(a);
      a.instance.exports.actor_init(type);
      checkMemory(a);
      flush(a);
    } catch (error) {
      failed(a, error);
    }
    return a.ref;
  }

  function send(ref, value, mailbox_claim = undefined) {
    if (closed) throw new Error('E_ACTOR: tenant closed');
    if (admissionClosed) throw new Error('E_ACTOR: mailbox admission closed after main returned');
    const a = Number.isInteger(ref) ? actors[ref] : undefined;
    if (!a) throw new Error('E_ACTOR: invalid actor reference');
    if (a.failed) throw new Error(fault || 'E_ACTOR_DEAD: target actor terminated');
    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) {
      throw new Error('E_ACTOR: mail must be a signed 64-bit value');
    }
    if (a.sent >= MAX_MAILBOX) {
      throw new Error(`E_MAILBOX_FULL: actor ${label(a)} already has ${MAX_MAILBOX} messages`);
    }
    if (pendingMessages >= MAX_TOTAL_PENDING_MESSAGES) {
      throw new Error('E_ACTOR_TOTAL_MAILBOX: aggregate pending-message budget exceeded');
    }
    if (mailbox_claim !== undefined) jobs.bind_mailbox(mailbox_claim, a.ref);
    a.mailbox.push({ value, sequence: a.sent, mailbox_claim });
    a.sent++;
    pendingMessages++;
  }

  function isLive(ref) {
    const actor = Number.isInteger(ref) ? actors[ref] : undefined;
    return !closed && !!actor && !actor.failed && actor.instance !== null;
  }

  function retire(ref) {
    const actor = Number.isInteger(ref) ? actors[ref] : undefined;
    if (closed || !actor) return false;
    const wasLive = !actor.failed && actor.instance !== null;
    actor.failed = true;
    const lost = actor.mailbox.length - actor.head;
    pendingMessages -= lost;
    droppedMessages += lost;
    for (let i = actor.head; i < actor.mailbox.length; i++) {
      const item = actor.mailbox[i];
      if (item?.mailbox_claim) jobs.observe_job(item.mailbox_claim, actor.ref, 'lost');
    }
    actor.mailbox.length = 0;
    actor.head = 0;
    actor.instance = null;
    actor.output.text = '';
    actor.output.truncated = false;
    return wasLive;
  }

  /** Round-robin, one mailbox entry per actor per sweep. This yields the JS
   * event loop between bounded groups of completed guest calls, never within
   * a guest Wasm invocation. Actor-to-actor sends are denied by guestImports.
   */
  async function drain() {
    if (closed) throw new Error('E_ACTOR: tenant closed');
    if (draining) throw new Error('E_ACTOR_PROTOCOL: concurrent drains');
    draining = true;
    admissionClosed = true;
    let steps = 0;
    try {
      while (true) {
        if (closed) return 'E_ACTOR: tenant closed';
        let progressed = false;
        for (const a of actors) {
          if (closed) return 'E_ACTOR: tenant closed';
          // A recoverable actor trap marks only that actor failed; healthy
          // siblings still drain before the tenant reports the first fault.
          if (a.failed || a.head >= a.mailbox.length) continue;
          progressed = true;
          const offset = a.head++;
          const { value, sequence, mailbox_claim } = a.mailbox[offset];
          a.mailbox[offset] = null; // never retain delivered guest values
          pendingMessages--;
          if (a.head === a.mailbox.length) {
            a.mailbox.length = 0;
            a.head = 0;
          }
          try {
            if (mailbox_claim) jobs.observe_job(mailbox_claim, a.ref, 'started');
            a.instance.exports.actor_receive(a.type, value, BigInt(sequence));
            checkMemory(a);
            flush(a);
            if (mailbox_claim) jobs.observe_job(mailbox_claim, a.ref, 'returned');
          } catch (error) {
            // A trap may occur after side effects. The job must remain
            // indeterminate, while healthy actors continue draining.
            if (mailbox_claim) jobs.observe_job(mailbox_claim, a.ref, 'lost');
            failed(a, error);
            continue;
          }
          if (++steps % YIELD_EVERY === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (closed) return 'E_ACTOR: tenant closed';
          }
        }
        if (!progressed) break;
      }
      return fault;
    } finally {
      draining = false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    jobs.close();
    groups.close();
    registry.close();
    for (const a of actors) {
      droppedMessages += a.mailbox.length - a.head;
      a.mailbox.length = 0;
      a.head = 0;
      a.instance = null;
      a.output.text = '';
    }
    pendingMessages = 0;
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
  const jobs = createLocalActorJobRouter({ registry, groups });
  const pubsub = createLocalPubSub(groups);
  return {
    spawn, send, getOrCreate, drain, close, isLive, retire, registry, groups, pubsub, jobs,
    get count() { return actors.length; },
    get memoryBytes() {
      return actors.reduce((sum, a) => sum + (a.instance?.exports.memory?.buffer.byteLength ?? 0), 0);
    },
    get stats() {
      return Object.freeze({ pendingMessages, droppedMessages,
        maxPendingMessages: MAX_TOTAL_PENDING_MESSAGES });
    }
  };
}
