/**
 * Bounded, host-only typed process groups and ephemeral pub/sub for local Atto actors.
 *
 * This is not an actor directory, an OTP supervisor, or a distributed broker.
 * Groups contain exact, non-retargeting ActorRef capabilities from ONE registry.
 * Admission of each fan-out message is independent; there is no atomic broadcast.
 */
const utf8 = new TextEncoder();
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

function name(value, label) {
  if (typeof value !== 'string' || !value.length) {
    throw new TypeError(`E_ACTOR_GROUP_KEY: ${label} must be a nonempty string`);
  }
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError('E_ACTOR_GROUP_KEY: invalid Unicode surrogate');
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new TypeError('E_ACTOR_GROUP_KEY: invalid Unicode surrogate');
    }
  }
  return value;
}

function limit(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_536) {
    throw new RangeError(`E_ACTOR_GROUP_LIMIT: invalid ${label}`);
  }
  return value;
}

export function createLocalActorGroups({registry, max_groups = 128,
  max_members_per_group = 256, max_memberships = 4096} = {}) {
  if (!registry || typeof registry.slot_for !== 'function' ||
      typeof registry.send !== 'function') {
    throw new TypeError('E_ACTOR_GROUP: an authenticated local registry is required');
  }
  limit(max_groups, 'max_groups');
  limit(max_members_per_group, 'max_members_per_group');
  limit(max_memberships, 'max_memberships');
  const groups = new Map();
  let memberships = 0;
  let closed = false;
  let busy = false;

  function run(fn) {
    if (closed) throw new Error('E_ACTOR_GROUP_CLOSED: group service closed');
    if (busy) throw new Error('E_ACTOR_GROUP_REENTRANT: callback reentered group service');
    busy = true;
    try { return fn(); } finally { busy = false; }
  }

  function normalize(group) {
    if (!group || typeof group !== 'object') {
      throw new TypeError('E_ACTOR_GROUP_KEY: group required');
    }
    const namespace = name(group.namespace, 'namespace');
    const group_name = name(group.group_name, 'group_name');
    const actor_type = group.actor_type;
    if (!Number.isSafeInteger(actor_type) || actor_type < 0) {
      throw new TypeError('E_ACTOR_GROUP_KEY: invalid actor type');
    }
    if (utf8.encode(namespace).length + utf8.encode(group_name).length > 4096) {
      throw new TypeError('E_ACTOR_GROUP_KEY: group exceeds 4096 UTF-8 bytes');
    }
    return Object.freeze({ namespace, actor_type, group_name });
  }

  function id(g) { return JSON.stringify([g.namespace, g.actor_type, g.group_name]); }

  function drop(key, g, ref) {
    if (!g.members.delete(ref)) return;
    memberships--;
    if (!g.members.size) groups.delete(key);
  }

  function live(ref) {
    try { registry.slot_for(ref); return true; }
    catch (error) {
      // Only stale/closed references are evicted. Unexpected host failures
      // must not silently appear as actor death.
      if (/^E_ACTOR_(REF_STALE|REGISTRY_CLOSED):/.test(error?.message ?? '')) return false;
      throw error;
    }
  }

  function prune(key, g) {
    for (const ref of [...g.members.keys()]) {
      if (!live(ref)) drop(key, g, ref);
      if (closed) throw new Error('E_ACTOR_GROUP_CLOSED: service closed during liveness check');
    }
  }

  function join(group, ref) {
    return run(() => {
      const g = normalize(group), key = id(g);
      if (!ref || ref.kind !== 'ActorRef' ||
          ref.namespace !== g.namespace || ref.actor_type !== g.actor_type) {
        throw new Error('E_ACTOR_GROUP_SCOPE: foreign namespace or actor type');
      }
      if (!live(ref)) throw new Error('E_ACTOR_REF_STALE: actor not live');
      const existing = groups.get(key);
      if (existing) prune(key, existing);
      const current = groups.get(key);
      const prior = current?.members.get(ref);
      if (prior) return prior;
      // Allocation is fail-atomic; no empty groups linger on rejection.
      if (!current && groups.size >= max_groups) throw new Error('E_ACTOR_GROUP_FULL: group quota');
      if (memberships >= max_memberships ||
          (current && current.members.size >= max_members_per_group)) {
        throw new Error('E_ACTOR_GROUP_FULL: membership quota');
      }
      const token = Object.freeze({});
      const target = current ?? { key: g, members: new Map() };
      target.members.set(ref, token);
      if (!current) groups.set(key, target);
      memberships++;
      return token;
    });
  }

  function leave(group, token) {
    return run(() => {
      const key = id(normalize(group));
      const g = groups.get(key);
      if (!g || !token || typeof token !== 'object') return false;
      for (const [ref, current] of g.members) {
        if (token === current) { drop(key, g, ref); return true; }
      }
      return false;
    });
  }

  function members(group) {
    return run(() => {
      const key = id(normalize(group)), g = groups.get(key);
      if (!g) return Object.freeze([]);
      prune(key, g);
      return Object.freeze([...(groups.get(key)?.members.keys() ?? [])]);
    });
  }

  function broadcast(group, payload) {
    return run(() => {
      if (typeof payload !== 'bigint' || payload < I64_MIN || payload > I64_MAX) {
        throw new TypeError('E_PUBSUB_PAYLOAD: current guest ABI requires signed i64');
      }
      const key = id(normalize(group)), g = groups.get(key);
      if (!g) return Object.freeze({ attempted: 0, admitted: 0, failed: 0, stale: 0 });
      prune(key, g);
      const refs = [...(groups.get(key)?.members.keys() ?? [])];
      let admitted = 0, failed = 0, stale = 0;
      for (const ref of refs) {
        if (closed) throw new Error('E_ACTOR_GROUP_CLOSED: service closed during broadcast');
        try {
          registry.send(ref, payload);
          admitted++;
        } catch (error) {
          if (/^E_ACTOR_(REF_STALE|REGISTRY_CLOSED):/.test(error?.message ?? '')) {
            const groupNow = groups.get(key);
            if (groupNow) drop(key, groupNow, ref);
            stale++;
          } else {
            // A full mailbox or a guest/host error is not an ACK. Keep the
            // subscription and expose partial delivery as a count.
            failed++;
          }
        }
      }
      return Object.freeze({ attempted: refs.length, admitted, failed, stale });
    });
  }

  // Deterministic rendezvous ranking: a stable job ID chooses ONE currently
  // eligible member. Changing membership may change assignment for a *new*
  // attempt; the job router separately fences retries of admitted IDs.
  function jobScore(job_id, slot) {
    const bytes = utf8.encode(JSON.stringify([job_id, slot]));
    let hash = 0xcbf29ce484222325n;
    for (const byte of bytes) {
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    }
    return hash;
  }

  function dispatch_one(group, job_id, payload) {
    return run(() => {
      if (typeof payload !== 'bigint' || payload < I64_MIN || payload > I64_MAX) {
        throw new TypeError('E_ACTOR_GROUP_PAYLOAD: current guest ABI requires signed i64');
      }
      const job = name(job_id, 'job_id');
      if (utf8.encode(job).length > 4096) {
        throw new TypeError('E_ACTOR_GROUP_KEY: job_id exceeds 4096 UTF-8 bytes');
      }
      const key = id(normalize(group));
      const existing = groups.get(key);
      if (existing) prune(key, existing);
      const current = groups.get(key);
      if (!current || !current.members.size) {
        throw new Error('E_ACTOR_GROUP_EMPTY: no live workers registered');
      }
      let selected = null, best = -1n, selectedSlot = Infinity;
      for (const ref of current.members.keys()) {
        const slot = registry.slot_for(ref);
        if (!Number.isSafeInteger(slot) || slot < 0) {
          throw new Error('E_ACTOR_GROUP_REF: invalid physical actor slot');
        }
        const score = jobScore(job, slot);
        if (score > best || (score === best && slot < selectedSlot)) {
          best = score;
          selectedSlot = slot;
          selected = ref;
        }
      }
      if (closed) throw new Error('E_ACTOR_GROUP_CLOSED: service closed during selection');
      try {
        // This send is the mailbox-admission linearization point. Never
        // retry a different member on error: admission may have happened.
        registry.send(selected, payload);
      } catch (error) {
        if (/^E_ACTOR_REF_STALE:/.test(error?.message ?? '')) {
          const now = groups.get(key);
          if (now) drop(key, now, selected);
        }
        throw error;
      }
      if (closed) throw new Error('E_ACTOR_GROUP_CLOSED: service closed during admission');
      return Object.freeze({ ref: selected });
    });
  }

  // Trusted-host death notification. It removes only the EXACT physical ref,
  // never a fresh incarnation with the same logical key. Hosts must call it
  // on crash/STOP; lazy prune is a fallback, not an equivalent monitor.
  function actor_stopped(ref) {
    return run(() => {
      let removed = 0;
      for (const [key, g] of groups) {
        if (g.members.has(ref)) { drop(key, g, ref); removed++; }
      }
      return removed;
    });
  }

  function close() {
    closed = true;
    groups.clear();
    memberships = 0;
  }

  return Object.freeze({ join, leave, members, broadcast, dispatch_one, actor_stopped, close,
    get group_count() { return groups.size; },
    get membership_count() { return memberships; } });
}

export function createLocalPubSub(groups) {
  if (!groups || ['join', 'leave', 'broadcast'].some(m => typeof groups[m] !== 'function')) {
    throw new TypeError('E_PUBSUB: local actor groups required');
  }
  return Object.freeze({
    subscribe: (topic, actor_ref) => groups.join(topic, actor_ref),
    unsubscribe: (topic, token) => groups.leave(topic, token),
    publish: (topic, value) => groups.broadcast(topic, value)
  });
}
