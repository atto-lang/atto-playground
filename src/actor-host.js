/** Actor host for guest contract atto.browser.guest.v2.
 *
 * Every `spawn` starts one dedicated Web Worker running src/actor-worker.js
 * with its own instance of the program's module, so actor state (instance
 * globals) is never shared. `send` posts mail in FIFO order with sequence
 * numbers from 0. The host lives inside the runner worker: terminating the
 * runner (Stop or the run deadline) also ends every actor worker it owns.
 */
import { appendCapped, MAX_ACTOR_TYPES } from './guest.js';

export const MAX_TOTAL_PENDING_MESSAGES = 20_000;
export const MAX_SINGLE_ACTOR_MEMORY_BYTES = 1 * 1024 * 1024;
export const MAX_TOTAL_ACTOR_MEMORY_BYTES = 8 * 1024 * 1024;
export const MAX_ACTOR_INIT_MS = 5_000;
export const MAX_ACTOR_WASM_BYTES = 1 << 20;
export const TERMINATION_REASONS = Object.freeze({
  NORMAL:'normal', PANIC:'panic', CANCELLED:'cancelled', SHUTDOWN:'shutdown',
  RESTART_LIMIT:'restart_limit', PROTOCOL:'protocol', INIT_FAILURE:'init_failure'
});
export const RESTART_STRATEGIES = Object.freeze({ONE_FOR_ONE:'one-for-one',ONE_FOR_ALL:'one-for-all'});
export const RESTART_POLICIES = Object.freeze({PERMANENT:'permanent',TRANSIENT:'transient',TEMPORARY:'temporary'});
const MAX_SUPERVISOR_EVENTS = 64;
function parseSupervisorConfig(value) {
  if(value==null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw new TypeError('E_SUPERVISOR_CONFIG: expected policy object');
  const strategy=value.strategy??'one-for-one',policy=value.policy??'permanent';
  const maxRestarts=value.maxRestarts??3,windowMs=value.windowMs??60_000;
  const initialBackoffMs=value.initialBackoffMs??10,maxBackoffMs=value.maxBackoffMs??1_000;
  if(!Object.values(RESTART_STRATEGIES).includes(strategy)||!Object.values(RESTART_POLICIES).includes(policy)||
    !Number.isSafeInteger(maxRestarts)||maxRestarts<0||maxRestarts>100||
    !Number.isSafeInteger(windowMs)||windowMs<1||windowMs>86_400_000||
    !Number.isSafeInteger(initialBackoffMs)||initialBackoffMs<1||initialBackoffMs>60_000||
    !Number.isSafeInteger(maxBackoffMs)||maxBackoffMs<initialBackoffMs||maxBackoffMs>60_000)
    throw new TypeError('E_SUPERVISOR_CONFIG: invalid strategy, restart policy or limits');
  return Object.freeze({strategy,policy,maxRestarts,windowMs,initialBackoffMs,maxBackoffMs});
}
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
  if (wasm instanceof Uint8Array && wasm.byteLength > MAX_ACTOR_WASM_BYTES) {
    throw new Error('E_ACTOR_MEMORY_POLICY: guest module exceeds 1 MiB admission limit');
  }
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
  // The local memory section alone is not the whole memory footprint:
  // the Wasm import section can also declare a memory. Validate the complete
  // module and reject memory imports before assigning any per-run quota.
  // This also prevents malformed non-memory sections from reaching a Worker.
  let module;
  try { module = new WebAssembly.Module(wasm); }
  catch { throw new Error('E_ACTOR_MEMORY_POLICY: invalid or unsupported Wasm module'); }
  if (WebAssembly.Module.imports(module).some(item => item.kind === 'memory')) {
    throw new Error('E_ACTOR_MEMORY_POLICY: imported memories are not admitted');
  }
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
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
  supervision = null, now = Date.now }) {
  if (!(wasm instanceof Uint8Array)) throw new TypeError('actor host needs the guest bytes');
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_ACTOR_TYPES) {
    throw new Error('actor host needs a valid actor table');
  }
  // Validate the same private snapshot that later determines admission and
  // diagnostic names. Accessor-backed caller arrays can change on each read.
  const admittedNames = Object.freeze(Array.from(names));
  if (!admittedNames.every(name => typeof name === 'string' &&
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) {
    throw new Error('actor host needs a valid actor table');
  }
  if (!Number.isSafeInteger(initTimeoutMs) || initTimeoutMs <= 0 || typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw new TypeError('invalid actor init timeout configuration');
  if(typeof now!=='function')throw new TypeError('E_SUPERVISOR_CONFIG: invalid clock');
  const supervisor=parseSupervisorConfig(supervision);
  // Both the quota proof and subsequent Worker spawns/restarts must use the
  // SAME immutable-by-ownership byte snapshot. Caller-owned Uint8Array and
  // actor table arrays may otherwise be edited after admission.
  if (wasm.byteLength > MAX_ACTOR_WASM_BYTES) {
    throw new Error('E_ACTOR_MEMORY_POLICY: guest module exceeds 1 MiB admission limit');
  }
  const admittedWasm = new Uint8Array(wasm);
  const actorMemoryBytesPerInstance = guestMemoryBudgetBytes(admittedWasm);
  const actors = [];
  // Reserved memory includes actors whose Worker termination has not been
  // physically acknowledged. Do not recycle that reservation mid-run.
  let actorMemoryBytes = 0, retiredActorMemoryBytes = 0;
  let pendingMessages = 0, droppedMessages = 0, restartCount = 0;
  let fault = null, closed = false, draining = false, terminal = false, terminalResult = null;
  const drainWaiters = [];
  const workerIdentities = new Set();
  let restartHistory=[], lastSupervisorTime=-1;
  const supervisorEvents=[];

  const label = a => `${a.name}#${a.id}`;
  function record(event){
    supervisorEvents.push(Object.freeze({...event}));
    if(supervisorEvents.length>MAX_SUPERVISOR_EVENTS)supervisorEvents.shift();
  }
  function cancelRestart(a){
    if(a.restartTimer!==null){clearTimer(a.restartTimer);a.restartTimer=null;}
  }
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
    if(worker){
      // A detached Worker has no acknowledged physical-quiescence barrier.
      retiredActorMemoryBytes+=actorMemoryBytesPerInstance;
      worker.onmessage=worker.onerror=worker.onmessageerror=null;
      try{worker.terminate();}catch{}
      workerIdentities.delete(worker);
    }
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
      worker.postMessage({kind:'init',wasm:new Uint8Array(admittedWasm),type:a.type});
    } catch(error) {
      if(worker&&ownsWorker){worker.onmessage=worker.onerror=worker.onmessageerror=null;try{worker.terminate();}catch{}workerIdentities.delete(worker);}
      if(a.worker===worker)a.worker=null;
      if(a.initTimer!==null){clearTimer(a.initTimer);a.initTimer=null;}
      throw error;
    }
  }
  function terminalFailure(a,message,reason=TERMINATION_REASONS.PROTOCOL){
    if(fault||closed)return;
    if(a){
      a.state='failed';cancelRestart(a);
      record({kind:'terminal',actorId:a.id,generation:a.generation,reason,message});
    }
    fault=`${message} in actor ${label(a)}`;
    // A terminal supervisor failure is a whole-host shutdown boundary.
    // Stop siblings and cancel all outstanding restart timers immediately,
    // not only when a caller eventually invokes close(). Retain conservative
    // mail accounting until close(), so failed/undelivered work is visible.
    for(const child of actors) {
      cancelRestart(child);
      detach(child);
    }
    check();
  }
  function recover(a,message){
    // A malformed actor protocol or startup error is never auto-restarted:
    // only a well-formed terminal E_PANIC issued by a current Worker qualifies.
    if(!supervisor||!message.startsWith('E_PANIC: '))return false;
    if(supervisor.policy===RESTART_POLICIES.TEMPORARY)return false;
    let time;
    try { time=now(); } catch {
      terminalFailure(a,'E_SUPERVISOR_CLOCK: clock failed',TERMINATION_REASONS.PROTOCOL);
      return true;
    }
    if(!Number.isSafeInteger(time)||time<0||time<lastSupervisorTime){
      terminalFailure(a,'E_SUPERVISOR_CLOCK: invalid clock',TERMINATION_REASONS.PROTOCOL);
      return true;
    }
    lastSupervisorTime=time;
    restartHistory=restartHistory.filter(t=>t>time-supervisor.windowMs && t<=time);
    if(restartHistory.length>=supervisor.maxRestarts){
      terminalFailure(a,'E_SUPERVISOR_RESTART_LIMIT: restart intensity exceeded',TERMINATION_REASONS.RESTART_LIMIT);
      return true;
    }
    const targets=supervisor.strategy===RESTART_STRATEGIES.ONE_FOR_ALL?
      actors.filter(x=>x===a||x.state==='starting'||x.state==='running'||x.state==='restarting'):[a];
    if(targets.some(x=>x.generation>=MAX_ACTOR_GENERATION)){
      terminalFailure(a,'E_ACTOR_GENERATION_EXHAUSTED: generation cannot wrap',TERMINATION_REASONS.RESTART_LIMIT);
      return true;
    }
    // Worker.terminate() has no physical-quiescence receipt. Charge every
    // replacement in addition to any retiring Worker, and hold retired bytes
    // for the lifetime of this execution. A previously scheduled replacement
    // without a live Worker already holds its future-instance reservation.
    const retiring=targets.filter(x=>x.worker!==null).length;
    if(actorMemoryBytes+retiring*actorMemoryBytesPerInstance>MAX_TOTAL_ACTOR_MEMORY_BYTES){
      terminalFailure(a,'E_ACTOR_RECLAIM_BUDGET: insufficient replacement headroom',TERMINATION_REASONS.RESTART_LIMIT);
      return true;
    }
    restartHistory.push(time);restartCount++;
    const delay=Math.min(supervisor.maxBackoffMs,
      supervisor.initialBackoffMs*2**Math.min(30,restartHistory.length-1));
    for(const target of targets){
      const lost=target.sent-target.done;
      pendingMessages-=lost;droppedMessages+=lost;
      cancelRestart(target);target.state='restarting';
      if(target.worker!==null){
        actorMemoryBytes+=actorMemoryBytesPerInstance;
      }
      detach(target);target.generation++;target.ready=false;
      target.sent=0;target.done=0;
      const generation=target.generation;
      record({kind:'restart_scheduled',actorId:target.id,generation,
        reason:target===a?TERMINATION_REASONS.PANIC:TERMINATION_REASONS.SHUTDOWN,
        delayMs:delay,droppedMessages:lost});
      try{
        let scheduledId=null;
        scheduledId=setTimer(()=>{
          // Cancelled callbacks can still be delivered. They must not clear
          // the timer owned by a newer incarnation of this child.
          if(target.generation!==generation||target.state!=='restarting'||
             target.restartTimer!==scheduledId)return;
          target.restartTimer=null;
          if(closed||fault)return;
          try{
            startWorker(target);
            record({kind:'restart_started',actorId:target.id,generation});
            check();
          }catch{
            terminalFailure(target,'E_SUPERVISOR_RESTART_INIT: replacement failed',TERMINATION_REASONS.INIT_FAILURE);
          }
        },delay);
        target.restartTimer=scheduledId;
      }catch{
        terminalFailure(target,'E_SUPERVISOR_TIMER: cannot schedule replacement',TERMINATION_REASONS.INIT_FAILURE);
        return true;
      }
    }
    check();
    return true;
  }
  function fail(a,message){
    if(fault||closed)return;
    if(a&&recover(a,message))return;
    terminalFailure(a,message,message.startsWith('E_PANIC: ')?
      TERMINATION_REASONS.PANIC:TERMINATION_REASONS.PROTOCOL);
  }
  function check() {
    if (!drainWaiters.length) return;
    if (terminal) {
      const waiters = drainWaiters.splice(0);
      for (const resolve of waiters) resolve(terminalResult);
      return;
    }
    if (fault || closed || actors.every(a => a.state==='stopped' || (a.ready && a.done === a.sent))) {
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
      // Automatic recovery is only authorized for a panic while a ready
      // actor has accepted (and not acknowledged) mail. A forged panic
      // before ready or with no admitted work is a protocol violation.
      // Do not credit its stdout or consume a supervisor restart permit.
      if (supervisor && typeof data.message === 'string' &&
          data.message.startsWith('E_PANIC: ') &&
          (!a.ready || a.done >= a.sent)) {
        terminalFailure(a,'E_ACTOR_PROTOCOL: unsolicited actor panic',
          TERMINATION_REASONS.PROTOCOL);
        return;
      }
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
    if(!Number.isInteger(type)||type<0||type>=admittedNames.length)throw new Error('E_ACTOR: unknown actor type');
    if(actors.length>=MAX_ACTORS)throw new Error(`E_ACTOR_LIMIT: at most ${MAX_ACTORS} actors per run`);
    if(actorMemoryBytes+actorMemoryBytesPerInstance>MAX_TOTAL_ACTOR_MEMORY_BYTES)throw new Error('E_ACTOR_TOTAL_MEMORY: aggregate actor memory budget exceeded');
    const id=actors.length,generation=1;
    const a={id,generation,type,name:admittedNames[type],sent:0,done:0,ready:false,state:'starting',worker:null,initTimer:null,restartTimer:null};
    actorMemoryBytes+=actorMemoryBytesPerInstance;
    try{startWorker(a);actors.push(a);return encodeActorRef(id,generation);}
    catch(error){actorMemoryBytes-=actorMemoryBytesPerInstance;fail(a,error?.message?.startsWith('E_ACTOR_ISOLATION:')?error.message:'E_ACTOR_INIT: worker initialization failed');throw error;}
  }

  function restart(handle) {
    if(closed)throw new Error('E_ACTOR: actor host closed');
    const a=resolve(handle);
    if(fault)throw new Error('E_ACTOR_FAILED: actor host has failed');
    if(draining || terminal)throw new Error('E_ACTOR_RESTART_CLOSED: actor host is draining or has already drained');
    if(a.state!=='running'||!a.ready||a.done!==a.sent)throw new Error('E_ACTOR_RESTART_BUSY: actor must be ready with an empty mailbox');
    if(a.generation>=MAX_ACTOR_GENERATION){a.state='failed';fail(a,'E_ACTOR_GENERATION_EXHAUSTED');detach(a);throw new Error('E_ACTOR_GENERATION_EXHAUSTED: actor generation cannot wrap');}
    if(actorMemoryBytes+actorMemoryBytesPerInstance>MAX_TOTAL_ACTOR_MEMORY_BYTES){
      throw new Error('E_ACTOR_RECLAIM_BUDGET: insufficient replacement headroom');
    }
    // The retiring Worker and the replacement must both be budgeted until
    // there is an independently verified backend-specific reclaim barrier.
    actorMemoryBytes+=actorMemoryBytesPerInstance;
    a.state='stopping';detach(a);a.generation++;a.sent=0;a.done=0;
    try{startWorker(a);return encodeActorRef(a.id,a.generation);}
    catch(error){a.state='failed';fail(a,'E_ACTOR_RESTART: worker restart failed');throw error;}
  }

  /** Supervisor/host-only stop: invalidate handle, detach child, reclaim its
   * reservation, and explicitly count discarded in-flight messages. */
  function stop(handle) {
    if(closed)throw new Error('E_ACTOR: actor host closed');
    const a=resolve(handle);
    if(fault)throw new Error('E_ACTOR_FAILED: actor host has failed');
    if(draining)throw new Error('E_ACTOR_FINALIZED: actor host is draining');
    cancelRestart(a);
    const lost=a.sent-a.done;
    pendingMessages-=lost;droppedMessages+=lost;
    a.state='stopped';detach(a);
    // No immediate refund: termination is requested but physical reclamation
    // is unverified. Slot admission uses actorMemoryBytes until close().
    record({kind:'stopped',actorId:a.id,generation:a.generation,
      reason:TERMINATION_REASONS.NORMAL,droppedMessages:lost});
    check();
  }
  /** Host-only identity lookup after automatic recovery. Never exported as
   * a Wasm capability or exposed across tenant/run boundaries. */
  function currentRef(id) {
    if(!supervisor)throw new Error('E_SUPERVISOR_DISABLED: currentRef is supervisor-only');
    if(!Number.isInteger(id)||id<0||id>=actors.length)
      throw new Error('E_ACTOR_REF_STALE: invalid actor reference (expired or stale)');
    const a=actors[id], handle=encodeActorRef(a.id,a.generation);
    resolve(handle);
    return handle;
  }

  function send(ref, value) {
    if (closed) throw new Error('E_ACTOR: actor host closed');
    const a = resolve(ref);
    if(a.state==='restarting'||a.state==='stopping')
      throw new Error('E_ACTOR_NOT_READY: actor is restarting');
    if (fault) throw new Error('E_ACTOR_FAILED: actor host has failed');
    if (draining) throw new Error('E_ACTOR_FINALIZED: actor host is draining');
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
    const normalCompletion = terminal && terminalResult === null;
    const shutdownReason = normalCompletion ? TERMINATION_REASONS.NORMAL :
      fault ? TERMINATION_REASONS.SHUTDOWN : TERMINATION_REASONS.CANCELLED;
    closed = true;
    // Preserve a completed successful drain; only cancel work that is still pending.
    if (!terminal && !fault) fault = 'E_ACTOR_CANCELLED: actor host closed';
    check(); // settle every pending drain; never leave a cancelled run hanging
    for (const a of actors) {
      if(a.state !== 'stopped') {
        const lost=a.sent-a.done;
        droppedMessages+=lost;
        record({kind:'stopped',actorId:a.id,generation:a.generation,
          reason:shutdownReason,droppedMessages:lost});
      }
      cancelRestart(a);
      a.state = 'stopped';
      detach(a);
    }
    workerIdentities.clear();
    // No further admissions are possible after close; drop logical budget
    // reservations but keep the unverified termination total observable.
    actorMemoryBytes = 0;
    pendingMessages = 0;
  }

  return { spawn, send, restart, stop, currentRef, drain, close,
    get count() { return actors.length; },
    get events() { return Object.freeze([...supervisorEvents]); },
    get stats() { return Object.freeze({ actors: actors.length, actorMemoryBytes,
      retiredActorMemoryBytes,physicalReclamationVerified:false,
      pendingMessages,droppedMessages,restartCount,
      restartPending:actors.filter(a=>a.restartTimer!==null).length,
      maxActorMemoryBytes: MAX_TOTAL_ACTOR_MEMORY_BYTES,
      maxPendingMessages: MAX_TOTAL_PENDING_MESSAGES }); }
  };
}
