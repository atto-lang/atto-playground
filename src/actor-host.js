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
export const ACTOR_REF_SLOT_BITS = 4;
export const MAX_ACTOR_GENERATION = 0x07ffffff;
const ACTOR_REF_SLOT_MASK = (1 << ACTOR_REF_SLOT_BITS) - 1;
export function encodeActorRef(slot, generation) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= MAX_ACTORS ||
      !Number.isSafeInteger(generation) || generation < 1 || generation > MAX_ACTOR_GENERATION) {
    throw new RangeError('E_ACTOR_REF: invalid actor slot or generation');
  }
  return (generation - 1) * (1 << ACTOR_REF_SLOT_BITS) + slot;
}
export function decodeActorRef(handle) {
  if (!Number.isInteger(handle) || handle < 0 || handle > 0x7fffffff) return null;
  const slot = handle & ACTOR_REF_SLOT_MASK;
  const generation = Math.floor(handle / (1 << ACTOR_REF_SLOT_BITS)) + 1;
  if (generation < 1 || generation > MAX_ACTOR_GENERATION) return null;
  return { slot, generation };
}
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
  let fault = null, closed = false, draining = false, terminal = false, terminalResult = null;
  const drainWaiters = [];
  const workerIdentities = new Set();

  const label = a => `${a.name}#${a.id}`;
  function resolve(handle) {
    const decoded = decodeActorRef(handle);
    if (!decoded) throw new Error('E_ACTOR_REF_STALE: invalid actor reference (expired or stale)');
    const actor = actors[decoded.slot];
    if (!actor || actor.generation !== decoded.generation || actor.state === 'stopped' || actor.state === 'failed') throw new Error('E_ACTOR_REF_STALE: invalid actor reference (expired or stale)');
    return actor;
  }
  function detach(a) {
    if (a.initTimer !== null) { clearTimer(a.initTimer); a.initTimer = null; }
    const worker=a.worker; a.worker=null;
    if(worker){worker.onmessage=worker.onerror=worker.onmessageerror=null;try{worker.terminate();}catch{}workerIdentities.delete(worker);}
  }
  function startWorker(a) {
    let worker=null, ownsWorker=false;
    try {
      worker=new WorkerImpl(workerUrl,{type:'module'});
      if(!worker||workerIdentities.has(worker)) throw new Error('E_ACTOR_ISOLATION: duplicate worker identity');
      workerIdentities.add(worker); ownsWorker=true; a.worker=worker; a.ready=false; a.state='starting';
      const generation=a.generation;
      worker.onmessage=event=>{if(closed||a.generation!==generation||a.worker!==worker)return;onMessage(a,event.data,generation,worker);};
      worker.onerror=event=>{event?.preventDefault?.();if(a.generation===generation&&a.worker===worker)fail(a,'E_ACTOR: worker failed to load or execute');};
      worker.onmessageerror=()=>{if(a.generation===generation&&a.worker===worker)fail(a,'E_ACTOR_PROTOCOL: undecodable actor message');};
      a.initTimer=setTimer(()=>{if(!a.ready&&!closed&&a.generation===generation&&a.worker===worker)fail(a,'E_ACTOR_INIT_TIMEOUT: actor worker did not become ready');},initTimeoutMs);
      worker.postMessage({kind:'init',wasm:new Uint8Array(wasm),type:a.type});
    } catch(error) {
      if(worker&&ownsWorker){worker.onmessage=worker.onerror=worker.onmessageerror=null;try{worker.terminate();}catch{}workerIdentities.delete(worker);}
      if(a.worker===worker)a.worker=null;
      if(a.initTimer!==null){clearTimer(a.initTimer);a.initTimer=null;}
      throw error;
    }
  }
  function fail(a, message) {
    if (fault || closed) return;
    if (a) a.state = 'failed';
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
  function onMessage(a, data, generation = a.generation, worker = a.worker) {
    if (a.generation !== generation || a.worker !== worker) return;
    if (closed || fault) return;
    if (data?.kind === 'fault') {
      // Preserve output produced before a genuine guest trap, but never
      // credit output from a malformed ready/done response.
      if (typeof data.stdout === 'string' && data.stdout) appendCapped(out, data.stdout);
      if (data.truncated) out.truncated = true;
      fail(a, typeof data.message === 'string' && /^E_[A-Z_]+: /.test(data.message) ? data.message : 'E_ACTOR: worker fault');
    } else if (data?.kind === 'done' && a.ready && data.sequence === a.done && a.done < a.sent) {
      if (typeof data.stdout === 'string' && data.stdout) appendCapped(out, data.stdout);
      if (data.truncated) out.truncated = true;
      a.done++;
      pendingMessages--;
      check();
    } else if (data?.kind === 'ready' && !a.ready) {
      a.ready = true;
      a.state = 'running';
      if (a.initTimer !== null) { clearTimer(a.initTimer); a.initTimer = null; }
      check();
    } else {
      fail(a, 'E_ACTOR_PROTOCOL: unexpected actor worker message');
    }
  }

  function spawn(type) {
    if(closed)throw new Error('E_ACTOR: actor host closed');
    if(fault)throw new Error('E_ACTOR_FAILED: actor host has failed');
    if(draining)throw new Error('E_ACTOR_FINALIZED: actor host is draining');
    if(!Number.isInteger(type)||type<0||type>=names.length)throw new Error('E_ACTOR: unknown actor type');
    if(actors.length>=MAX_ACTORS)throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);
    if(actorMemoryBytes+actorMemoryBytesPerInstance>MAX_TOTAL_ACTOR_MEMORY_BYTES)throw new Error('E_ACTOR_TOTAL_MEMORY: aggregate actor memory budget exceeded');
    const id=actors.length,generation=1;
    const a={id,generation,type,name:names[type],sent:0,done:0,ready:false,state:'starting',worker:null,initTimer:null};
    actorMemoryBytes+=actorMemoryBytesPerInstance;
    try{startWorker(a);actors.push(a);return encodeActorRef(id,generation);}
    catch(error){actorMemoryBytes-=actorMemoryBytesPerInstance;fail(a,error?.message?.startsWith('E_ACTOR_ISOLATION:')?error.message:'E_ACTOR_INIT: worker initialization failed');throw error;}
  }

  function restart(handle) {
    if(closed)throw new Error('E_ACTOR: actor host closed');
    if(fault)throw new Error('E_ACTOR_FAILED: actor host has failed');
    if(draining || terminal)throw new Error('E_ACTOR_RESTART_CLOSED: actor host is draining or has already drained');
    const a=resolve(handle);
    if(a.state!=='running'||!a.ready||a.done!==a.sent)throw new Error('E_ACTOR_RESTART_BUSY: actor must be ready with an empty mailbox');
    if(a.generation>=MAX_ACTOR_GENERATION){a.state='failed';fail(a,'E_ACTOR_GENERATION_EXHAUSTED');detach(a);throw new Error('E_ACTOR_GENERATION_EXHAUSTED: actor generation cannot wrap');}
    a.state='stopping';detach(a);a.generation++;a.sent=0;a.done=0;
    try{startWorker(a);return encodeActorRef(a.id,a.generation);}
    catch(error){a.state='failed';fail(a,'E_ACTOR_RESTART: worker restart failed');throw error;}
  }

  function send(ref, value) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    if (fault) throw new Error('E_ACTOR_FAILED: actor host has failed');
    if (draining) throw new Error('E_ACTOR_FINALIZED: actor host is draining');
    const a = resolve(ref);
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
    draining = true;
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
      a.state = 'stopped';
      detach(a);
    }
    workerIdentities.clear();
    actorMemoryBytes = 0;
    pendingMessages = 0;
  }

  return { spawn, send, restart, drain, close,
    get count() { return actors.length; },
    get stats() { return Object.freeze({ actors: actors.length, actorMemoryBytes, pendingMessages, maxActorMemoryBytes: MAX_TOTAL_ACTOR_MEMORY_BYTES, maxPendingMessages: MAX_TOTAL_PENDING_MESSAGES }); }
  };
}
