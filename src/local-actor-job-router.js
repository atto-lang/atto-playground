/**
 * Bounded, host-only assignment of job IDs to ALREADY LIVE actors or groups.
 *
 * A successful call proves one local mailbox admission, not execution, a
 * durable receipt, or exactly-once delivery. Indeterminate admissions remain
 * reserved: callers must NOT silently retry a possibly admitted job.
 */
const utf8 = new TextEncoder();
const I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`E_ACTOR_JOB_KEY: ${field} must be a nonempty string`);
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('E_ACTOR_JOB_KEY: invalid Unicode surrogate');
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('E_ACTOR_JOB_KEY: invalid Unicode surrogate');
    }
  }
  return value;
}

function target_spec(target) {
  if (!target || typeof target !== 'object') {
    throw new TypeError('E_ACTOR_JOB_TARGET: target required');
  }
  const kind = target.kind;
  if (kind !== 'actor' && kind !== 'group') {
    throw new TypeError('E_ACTOR_JOB_TARGET: expected actor or group');
  }
  const source = kind === 'actor' ? target.key : target.group;
  if (!source || typeof source !== 'object') {
    throw new TypeError('E_ACTOR_JOB_TARGET: typed target key required');
  }
  const namespace = text(source.namespace, 'namespace');
  const actor_type = source.actor_type;
  if (!Number.isSafeInteger(actor_type) || actor_type < 0) {
    throw new TypeError('E_ACTOR_JOB_TARGET: invalid actor type');
  }
  const target_name = text(kind === 'actor' ? source.application_key : source.group_name,
    kind === 'actor' ? 'application_key' : 'group_name');
  if (utf8.encode(namespace).length + utf8.encode(target_name).length > 4096) {
    throw new TypeError('E_ACTOR_JOB_KEY: target exceeds 4096 UTF-8 bytes');
  }
  const key = Object.freeze(kind === 'actor'
    ? { namespace, actor_type, application_key: target_name }
    : { namespace, actor_type, group_name: target_name });
  return Object.freeze({ kind, key, namespace,
    fingerprint: JSON.stringify([kind, namespace, actor_type, target_name]) });
}

export function createLocalActorJobRouter({ registry, groups, max_jobs = 4096 } = {}) {
  if (!registry || typeof registry.lookup !== 'function' || typeof registry.send !== 'function' ||
      !groups || typeof groups.dispatch_one !== 'function') {
    throw new TypeError('E_ACTOR_JOB: authenticated registry and group dispatcher required');
  }
  if (!Number.isSafeInteger(max_jobs) || max_jobs < 1 || max_jobs > 65_536) {
    throw new RangeError('E_ACTOR_JOB_LIMIT: invalid max_jobs');
  }
  const receipts = new Map();
  // Opaque per-admission markers are never returned in user-visible receipts.
  // Only the trusted mailbox adapter receives them; the Wasm guest does not.
  const claims = new WeakMap();
  let closed = false, busy = false;

  function checked_open() {
    if (closed) throw new Error('E_ACTOR_JOB_CLOSED: router closed');
  }

  function dispatch_job({ job_id, target, value } = {}) {
    checked_open();
    if (busy) throw new Error('E_ACTOR_JOB_REENTRANT: recursive job dispatch');
    const dest = target_spec(target);
    const id = text(job_id, 'job_id');
    if (utf8.encode(dest.namespace).length + utf8.encode(id).length > 4096) {
      throw new TypeError('E_ACTOR_JOB_KEY: job identity exceeds 4096 UTF-8 bytes');
    }
    if (typeof value !== 'bigint' || value < I64_MIN || value > I64_MAX) {
      throw new TypeError('E_ACTOR_JOB_PAYLOAD: current guest ABI requires signed i64');
    }
    const identity = JSON.stringify([dest.namespace, id]);
    const previous = receipts.get(identity);
    if (previous) {
      if (previous.fingerprint !== dest.fingerprint || previous.value !== value) {
        throw new Error('E_ACTOR_JOB_CONFLICT: job ID already assigned a different target or payload');
      }
      if (previous.state === 'indeterminate') {
        throw new Error('E_ACTOR_JOB_INDETERMINATE: prior admission outcome is unknown');
      }
      return Object.freeze({ status: 'duplicate', job_id: id, ref: previous.ref });
    }
    if (receipts.size >= max_jobs) {
      throw new Error('E_ACTOR_JOB_FULL: local job receipt capacity reached');
    }

    checked_open(); // A hostile key getter must not close the router unnoticed.
    busy = true;
    try {
      let ref, empty = false;
      const pending = { state: 'preparing', fingerprint: dest.fingerprint,
        value, ref: null, slot: null, claim: Object.freeze({}) };
      claims.set(pending.claim, pending);
      if (dest.kind === 'actor') {
        ref = registry.lookup(dest.key);
        checked_open();
        if (!ref) throw new Error('E_ACTOR_JOB_ABSENT: actor is not registered and live');
      }
      try {
        if (dest.kind === 'actor') registry.send(ref, value, pending.claim);
        else {
          const placement = groups.dispatch_one(dest.key, id, value, pending.claim);
          if (placement === null) empty = true; // Explicit pre-send outcome.
          else if (!placement || typeof placement.ref !== 'object' || !placement.ref) {
            throw new Error('E_ACTOR_JOB_TARGET: invalid group admission receipt');
          } else ref = placement.ref;
        }
      } catch (cause) {
        // All thrown errors may happen AFTER external mailbox admission.
        // An empty group is conveyed only by a successful null return.
        if (!closed) {
          pending.state = 'indeterminate';
          receipts.set(identity, pending);
        }
        throw new Error('E_ACTOR_JOB_INDETERMINATE: dispatch failed; do not automatically retry', { cause });
      }
      if (empty) throw new Error('E_ACTOR_GROUP_EMPTY: no live workers registered');
      if (closed) {
        throw new Error('E_ACTOR_JOB_INDETERMINATE: router closed during admission');
      }
      pending.state = 'admitted';
      pending.ref = ref;
      receipts.set(identity, pending);
      return Object.freeze({ status: 'admitted', job_id: id, ref });
    } finally {
      busy = false;
    }
  }

  /** Trusted mailbox callback: bind a fresh router-issued claim to the exact
   * monotonically allocated actor slot before queue insertion. Never call
   * this for ordinary, uncorrelated actor sends. A bad claim fails closed. */
  function bind_mailbox(claim, slot) {
    checked_open();
    const record = claim && typeof claim === 'object' ? claims.get(claim) : null;
    if (!record || record.state !== 'preparing' || record.slot !== null ||
        !Number.isSafeInteger(slot) || slot < 0) {
      throw new Error('E_ACTOR_JOB_CLAIM: unknown, duplicate or invalid mailbox claim');
    }
    record.slot = slot;
  }

  /** Host observation after a real Wasm receive call, NOT a guest ACK.
   * An observed return means actor_receive returned and memory validation
   * succeeded; it does not prove an external side effect or durability. */
  function observe_job(claim, slot, event) {
    checked_open();
    const record = claim && typeof claim === 'object' ? claims.get(claim) : null;
    if (!record || record.slot !== slot || !Number.isSafeInteger(slot) || slot < 0) {
      throw new Error('E_ACTOR_JOB_CLAIM: forged, stale or foreign delivery observation');
    }
    if (event === 'started' &&
        (record.state === 'admitted' || record.state === 'indeterminate')) {
      record.state = 'observed_started';
    } else if (event === 'returned' && record.state === 'observed_started') {
      record.state = 'observed_executed';
    } else if (event === 'lost' &&
        (record.state === 'admitted' || record.state === 'observed_started' ||
         record.state === 'indeterminate' || record.state === 'preparing')) {
      // Lost acknowledgements and traps may follow side effects. Never
      // permit blind redelivery, regardless of whether the actor started.
      record.state = 'indeterminate';
    } else {
      throw new Error('E_ACTOR_JOB_STATE: invalid delivery observation transition');
    }
    return record.state;
  }

  function inspect(namespace, job_id) {
    checked_open();
    const ns = text(namespace, 'namespace'), id = text(job_id, 'job_id');
    if (utf8.encode(ns).length + utf8.encode(id).length > 4096) {
      throw new TypeError('E_ACTOR_JOB_KEY: job identity exceeds 4096 UTF-8 bytes');
    }
    const prior = receipts.get(JSON.stringify([ns, id]));
    return prior ? Object.freeze({ status: prior.state, ref: prior.ref }) : null;
  }

  function close() {
    if (closed) return;
    closed = true;
    receipts.clear();
  }

  return Object.freeze({ dispatch_job, bind_mailbox, observe_job, inspect, close,
    get size() { return receipts.size; } });
}
