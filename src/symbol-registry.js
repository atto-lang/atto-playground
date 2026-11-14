/**
 * Per-tenant, host-owned AttoLang symbol identities.
 *
 * A symbol is a copyable (registry, id) value, NOT a pointer into an actor
 * heap, a JavaScript Symbol, or a transferable capability.  The host owns
 * the immutable spelling; Web Workers exchange only structured-clone-safe
 * handles.  The caller must enforce module export/import visibility: knowing
 * a symbol's name/handle grants no authority.
 *
 * Only explicitly exported/core symbols are global.  An undeclared #literal
 * remains isolate-local, even if another isolate uses the same spelling.
 */
export const MAX_SYMBOLS = 16_384;
export const MAX_SYMBOL_BYTES = 1 << 20;
export const MAX_SYMBOL_KEY_BYTES = 4_096;

const encoder = new TextEncoder();
export const SUPERVISOR_ISOLATE_ID = 0;

/** Actor refs are zero-based; zero is reserved for the supervisor. */
export function actorIsolateId(actorRef) {
  if (!Number.isSafeInteger(actorRef) || actorRef < 0 ||
      actorRef >= Number.MAX_SAFE_INTEGER) {
    throw new TypeError('E_SYMBOL_SCOPE: invalid actor reference');
  }
  return actorRef + 1;
}

/** Do not permit ill-formed UTF-16 strings to alias UTF-8 replacement bytes. */
function requireScalarUnicode(value) {
  for (const c of value) {
    const code = c.codePointAt(0);
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new TypeError('E_SYMBOL_NAME: unpaired UTF-16 surrogate');
    }
  }
}

function utf8Bytes(value) {
  // One UTF-16 code unit occupies at least one UTF-8 byte; reject oversized
  // names before building their allocation-heavy map key.
  if (value.length > MAX_SYMBOL_KEY_BYTES) {
    throw new RangeError('E_SYMBOL_LIMIT: symbol intern budget exceeded');
  }
  requireScalarUnicode(value);
  return encoder.encode(value).byteLength;
}

function requireModule(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('E_SYMBOL_NAME: invalid canonical module name');
  }
  requireScalarUnicode(value);
}
function requireName(value) {
  if (typeof value !== 'string' || value.length < 2 || value[0] !== '#' ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('E_SYMBOL_NAME: expected a #symbol literal');
  }
  requireScalarUnicode(value);
}
function requireOwner(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('E_SYMBOL_SCOPE: isolate id must be a nonnegative safe integer');
  }
}

/**
 * A registry is created once per tenant and must be owned by its supervisor.
 * Its UUID prevents handles from one tenant accidentally resolving in another.
 * All calls in one JS agent are synchronous; the host mediates other workers.
 */
export function createSymbolRegistry({
  maxSymbols = MAX_SYMBOLS, maxBytes = MAX_SYMBOL_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxSymbols) || maxSymbols < 1 ||
      maxSymbols > MAX_SYMBOLS || !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 || maxBytes > MAX_SYMBOL_BYTES) {
    throw new RangeError('E_SYMBOL_LIMIT: invalid registry limits');
  }
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('E_SYMBOL_RUNTIME: secure registry UUID unavailable');
  }

  const registry = globalThis.crypto.randomUUID();
  const byKey = new Map();
  const byId = new Map();
  let nextId = 1n;
  let bytes = 0;
  let closed = false;

  function requireOpen() {
    if (closed) throw new Error('E_SYMBOL_CLOSED: registry has been closed');
  }

  function intern(scope, owner, moduleName, name) {
    requireOpen();
    requireModule(moduleName);
    requireName(name);
    if (scope === 'local') requireOwner(owner);

    const cost = utf8Bytes(moduleName) + utf8Bytes(name);
    if (cost > MAX_SYMBOL_KEY_BYTES) {
      throw new RangeError('E_SYMBOL_LIMIT: symbol intern budget exceeded');
    }
    // An array-based canonical key avoids ambiguity between punctuation,
    // module names and #with spaces spellings; do not use string hashes as IDs.
    const key = JSON.stringify([scope, scope === 'local' ? owner : null, moduleName, name]);
    const existing = byKey.get(key);
    if (existing) return existing;
    if (byId.size >= maxSymbols || cost > maxBytes - bytes) {
      throw new RangeError('E_SYMBOL_LIMIT: symbol intern budget exceeded');
    }

    const handle = Object.freeze({ registry, id: nextId++ });
    byKey.set(key, handle);
    byId.set(handle.id, Object.freeze({
      scope, owner: scope === 'local' ? owner : null, module: moduleName, name, handle,
    }));
    bytes += cost;
    return handle;
  }

  function isHandle(handle) {
    return !closed && handle !== null && typeof handle === 'object' &&
      handle.registry === registry && typeof handle.id === 'bigint' &&
      byId.has(handle.id);
  }

  /** Resolve only within the host-controlled isolate context. */
  function resolve(handle, isolateId) {
    requireOpen();
    requireOwner(isolateId);
    if (!isHandle(handle)) return null;
    const symbol = byId.get(handle.id);
    if (symbol.scope === 'local' && symbol.owner !== isolateId) return null;
    return Object.freeze({ scope: symbol.scope, module: symbol.module, name: symbol.name });
  }

  /** Private symbols must never cross isolate boundaries, even by value. */
  function canTransport(handle, fromIsolateId, toIsolateId) {
    requireOpen();
    requireOwner(fromIsolateId);
    requireOwner(toIsolateId);
    if (!isHandle(handle)) return false;
    const symbol = byId.get(handle.id);
    return symbol.scope === 'global' ||
      (symbol.owner === fromIsolateId && fromIsolateId === toIsolateId);
  }

  /** Value equality remains correct after postMessage/structuredClone. */
  function same(left, right) {
    return isHandle(left) && isHandle(right) &&
      left.id === right.id;
  }

  /** Export only public/core identities, never private actor-local symbols. */
  function globalManifest() {
    requireOpen();
    return Object.freeze([...byId.values()]
      .filter(entry => entry.scope === 'global')
      .map(entry => Object.freeze({
        module: entry.module, name: entry.name, handle: entry.handle,
      })));
  }

  function close() {
    if (closed) return;
    closed = true;
    byKey.clear();
    byId.clear();
    bytes = 0;
  }

  return Object.freeze({
    internGlobal(moduleName, name) { return intern('global', null, moduleName, name); },
    internLocal(isolateId, moduleName, name) {
      return intern('local', isolateId, moduleName, name);
    },
    same, resolve, canTransport, globalManifest, close,
    get count() { return byId.size; },
    get bytes() { return bytes; },
    get registryId() { return registry; },
  });
}
