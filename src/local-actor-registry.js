/**
 * Local keyed actor routing for the browser/tenant hosts.
 *
 * This is a host-side, synchronous activation registry, not a distributed
 * Orleans-style directory or a compiled AttoLang ActorRef<T> value.
 * The guest i32 actor ABI is unchanged. Physical references never retarget.
 */
const MAX_KEY_BYTES = 4096;
const utf8 = new TextEncoder();

function validText(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`E_ACTOR_KEY: ${field} must be a nonempty string`);
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('E_ACTOR_KEY: invalid Unicode surrogate');
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError('E_ACTOR_KEY: invalid Unicode surrogate');
    }
  }
  return value;
}

export function createLocalActorRegistry({ names, spawn, send, isLive, retire }) {
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !n)) {
    throw new TypeError('E_ACTOR_REGISTRY: actor name table required');
  }
  if ([spawn, send, isLive, retire].some(fn => typeof fn !== 'function')) {
    throw new TypeError('E_ACTOR_REGISTRY: host lifecycle callbacks required');
  }
  // Snapshot the type table: callers must not change logical identity or its
  // UTF-8 budget by mutating a names array after registry construction.
  const actorNames = Object.freeze(names.map(n => validText(n, 'actor name')));
  // Capabilities and the epoch are deliberately unexported. Never expose
  // physical slots to guest code.
  const epoch = Object.freeze({});
  const entries = new Map();
  const creating = new Set();
  const physical = new WeakMap();
  // Global monotonic BigInt avoids an unbounded per-key incarnation tombstone
  // map while still preventing ABA within this registry's unique epoch.
  let nextIncarnation = 0n;
  // A host physical slot must not be reused in one registry lifetime: the
  // existing actor hosts allocate monotonically and never recycle slots.
  const seenSlots = new Set();
  let closed = false;

  function normalize(value) {
    const key = value?.kind === 'VirtualActorRef' ? value.key : value;
    if (!key || typeof key !== 'object') throw new TypeError('E_ACTOR_KEY: key required');
    const namespace = validText(key.namespace, 'namespace');
    const application_key = validText(key.application_key, 'application_key');
    const actor_type = key.actor_type;
    if (!Number.isInteger(actor_type) || actor_type < 0 || actor_type >= names.length) {
      throw new TypeError('E_ACTOR_KEY: unknown actor type');
    }
    if (utf8.encode(namespace).length + utf8.encode(actorNames[actor_type]).length +
        utf8.encode(application_key).length > MAX_KEY_BYTES) {
      throw new TypeError('E_ACTOR_KEY: key exceeds 4096 UTF-8 bytes');
    }
    return Object.freeze({ namespace, actor_type, application_key });
  }

  function identity(key) {
    // Unambiguous across colons, NULs, slashes, Unicode and key boundaries.
    return JSON.stringify([key.namespace, key.actor_type, key.application_key]);
  }

  function active(entry) {
    return entry && isLive(entry.slot);
  }

  function checkedOpen() {
    if (closed) throw new Error('E_ACTOR_REGISTRY_CLOSED: registry closed');
  }

  function ref_for(key) {
    checkedOpen();
    return Object.freeze({ kind: 'VirtualActorRef', key: normalize(key) });
  }

  function lookup(key) {
    checkedOpen();
    const id = identity(normalize(key));
    const entry = entries.get(id);
    const live = active(entry);
    // An injected host callback may close the registry or retire the entry.
    checkedOpen();
    return live && entries.get(id) === entry ? entry.ref : null;
  }

  function retireChecked(slot, code) {
    try {
      retire(slot);
      // A callback may return false, undefined, or even claim success while
      // still leaving the physical actor alive. Check host liveness directly.
      if (isLive(slot)) {
        throw new Error('physical actor remains live after retirement');
      }
    } catch (cause) {
      // With uncertain retirement, allowing a new owner would violate keyed
      // actor uniqueness. Quarantine this registry for the rest of its epoch.
      close();
      throw new Error(code + ': registry quarantined after uncertain retirement', { cause });
    }
  }

  function rollback(slot) {
    retireChecked(slot, 'E_ACTOR_REGISTRY_ROLLBACK');
  }

  function register(key) {
    checkedOpen();
    const normalized = normalize(key);
    const id = identity(normalized);
    const existing = entries.get(id);
    const live = active(existing);
    checkedOpen();
    // A host liveness probe may reenter and publish a new incarnation.
    // Never overwrite that successor after returning from the callback.
    const observed = entries.get(id);
    if (observed && observed !== existing) {
      throw new Error('E_ACTOR_REGISTRY_REENTRANT: key replaced during liveness check');
    }
    if (live && entries.get(id) === existing) {
      return Object.freeze({ ref: existing.ref, token: null, created: false });
    }
    if (creating.has(id)) throw new Error('E_ACTOR_REGISTRY_RECURSIVE: same-key recursive activation');
    // Synchronous JS event-loop activation is atomic with publication.
    // Async factories and distributed single-flight remain out of scope.
    creating.add(id);
    try {
      const slot = spawn(normalized.actor_type);
      if (!Number.isSafeInteger(slot) || slot < 0) {
        throw new Error('E_ACTOR_REGISTRY_DEAD: activation returned an invalid slot');
      }
      if (seenSlots.has(slot)) {
        // Never retire the aliased slot: it could belong to another live key.
        throw new Error('E_ACTOR_REGISTRY_SLOT_REUSE: physical slot was already issued');
      }
      seenSlots.add(slot);
      // isLive itself may be a reentrant host callback that closes registry.
      let live;
      try {
        live = isLive(slot);
      } catch (cause) {
        rollback(slot);
        throw cause;
      }
      if (closed || !live) {
        rollback(slot);
        throw new Error(closed
          ? 'E_ACTOR_REGISTRY_CLOSED: activation cancelled during shutdown'
          : 'E_ACTOR_REGISTRY_DEAD: activation did not produce a live actor');
      }
      nextIncarnation += 1n;
      const token = Object.freeze({});
      const ref = Object.freeze({
        kind: 'ActorRef', actor_type: normalized.actor_type,
        namespace: normalized.namespace, application_key: normalized.application_key,
        incarnation: nextIncarnation
      });
      physical.set(ref, { epoch, slot });
      entries.set(id, { ref, slot, token });
      return Object.freeze({ ref, token, created: true });
    } finally {
      creating.delete(id);
    }
  }

  function get_or_create(key) {
    return register(key).ref;
  }

  function unregister(key, token) {
    checkedOpen();
    const id = identity(normalize(key));
    const current = entries.get(id);
    if (!current || !token || current.token !== token) return false;
    entries.delete(id); // Stale cleanup cannot remove a successor.
    retireChecked(current.slot, 'E_ACTOR_REGISTRY_RETIRE_FAILED');
    return true;
  }

  // Trusted host adapter for the existing v2 guest ABI's i32 slot.
  // Never pass this function to guest code or serialize physical refs.
  function slot_for(ref) {
    checkedOpen();
    const target = ref && typeof ref === 'object' ? physical.get(ref) : null;
    if (!target || target.epoch !== epoch) {
      throw new Error('E_ACTOR_REF_STALE: foreign or forged physical actor reference');
    }
    const id = identity(normalize(ref));
    const entry = entries.get(id);
    if (!entry || entry.ref !== ref || !isLive(target.slot)) {
      throw new Error('E_ACTOR_REF_STALE: activation no longer live');
    }
    checkedOpen();
    if (entries.get(id) !== entry) {
      throw new Error('E_ACTOR_REF_STALE: activation retired during resolution');
    }
    return target.slot;
  }

  function send_to(ref, value) {
    checkedOpen();
    const target = ref && typeof ref === 'object' ? physical.get(ref) : null;
    if (!target || target.epoch !== epoch) {
      throw new Error('E_ACTOR_REF_STALE: foreign or forged physical actor reference');
    }
    const id = identity(normalize(ref));
    const current = entries.get(id);
    if (!current || current.ref !== ref || !isLive(target.slot)) {
      throw new Error('E_ACTOR_REF_STALE: activation no longer live');
    }
    checkedOpen();
    if (entries.get(id) !== current) {
      throw new Error('E_ACTOR_REF_STALE: activation retired during resolution');
    }
    // Host send() is the admission linearization point, not the lookup.
    // A successful return never asserts a completed or durable delivery.
    send(target.slot, value);
  }

  function close() {
    if (closed) return;
    closed = true;
    entries.clear();
    creating.clear();
    seenSlots.clear(); // Registry stays closed; no future allocation possible.
  }

  return Object.freeze({
    ref_for, lookup, register, get_or_create, unregister, send: send_to, slot_for, close,
    get size() { return entries.size; }
  });
}
