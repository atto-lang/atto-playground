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
  // Identity is private to this registry instance. Tokens and physical refs
  // are capability objects; exposing a numeric actor slot would allow forgery.
  const epoch = Object.freeze({});
  const entries = new Map();
  const generations = new Map();
  const creating = new Set();
  const physical = new WeakMap();
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
    if (utf8.encode(namespace).length + utf8.encode(names[actor_type]).length +
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
    const entry = entries.get(identity(normalize(key)));
    return active(entry) ? entry.ref : null;
  }

  function register(key) {
    checkedOpen();
    const normalized = normalize(key);
    const id = identity(normalized);
    const existing = entries.get(id);
    if (active(existing)) return Object.freeze({ ref: existing.ref, token: null, created: false });
    if (creating.has(id)) throw new Error('E_ACTOR_REGISTRY_RECURSIVE: same-key recursive activation');
    // JS synchronous host execution makes activation + publication atomic
    // within this event loop. No async factory or promise gap is supported.
    creating.add(id);
    try {
      const slot = spawn(normalized.actor_type);
      if (!Number.isSafeInteger(slot) || slot < 0 || !isLive(slot)) {
        throw new Error('E_ACTOR_REGISTRY_DEAD: activation did not produce a live actor');
      }
      const incarnation = (generations.get(id) ?? 0n) + 1n;
      generations.set(id, incarnation); // Retained after unregister: no ABA.
      const token = Object.freeze({});
      const ref = Object.freeze({
        kind: 'ActorRef', actor_type: normalized.actor_type,
        namespace: normalized.namespace, application_key: normalized.application_key,
        incarnation
      });
      physical.set(ref, { epoch, slot });
      entries.set(id, { ref, slot, token });
      return Object.freeze({ ref, token, created: true });
    } finally {
      creating.delete(id); // Failed activations never strand the key.
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
    entries.delete(id); // Remove first; stale cleanup cannot find successor.
    retire(current.slot);
    return true;
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
    // Host send() is the admission linearization point, not the lookup.
    // A successful return never asserts a completed or durable delivery.
    send(target.slot, value);
  }

  function close() {
    if (closed) return;
    closed = true;
    entries.clear();
    creating.clear();
    // Retained only until this registry instance is unreachable.
    generations.clear();
  }

  return Object.freeze({
    ref_for, lookup, register, get_or_create, unregister, send: send_to, close,
    get size() { return entries.size; }
  });
}
