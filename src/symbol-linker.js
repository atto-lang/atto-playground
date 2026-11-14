/** Host-authorized, cross-module Symbol linking contract (phase 1).
 *
 * Module ids and import grants must come from a trusted package/link plan,
 * NOT from user-controlled Wasm custom sections or a guest's request.
 * The compiler's existing atto.symbols manifest proves only local public
 * declarations. It does not yet encode source-level cross-module imports.
 *
 * A link result is a registry-scoped, immutable identity, NOT an actor
 * capability, raw guest ordinal, shared-memory address or permission.
 */
import { symbolManifest, privateSymbolManifest } from './guest.js';
import { createSymbolRegistry, SUPERVISOR_ISOLATE_ID } from './symbol-registry.js';

const MODULE_ID = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const MAX_MODULES = 256;
const MAX_GRANTS = 16384;
const keyOf = (...parts) => JSON.stringify(parts);

export function createAuthorizedSymbolLinker({ modules, importGrants = [] }) {
  if (!Array.isArray(modules) || modules.length < 1 || modules.length > MAX_MODULES ||
      !Array.isArray(importGrants) || importGrants.length > MAX_GRANTS) {
    throw new Error('E_SYMBOL_LINK: invalid module/link budget');
  }

  const byModule = new Map();
  for (const entry of modules) {
    if (!entry || typeof entry.id !== 'string' || !MODULE_ID.test(entry.id) ||
        !(entry.module instanceof WebAssembly.Module) || byModule.has(entry.id)) {
      throw new Error('E_SYMBOL_LINK: invalid or duplicate module descriptor');
    }
    // These manifests are decoded from actual Wasm bytes, never accepted as
    // caller-supplied name arrays. Private names stay in the owning isolate.
    const names = symbolManifest(entry.module);
    const privateNames = privateSymbolManifest(entry.module, names);
    byModule.set(entry.id, {
      exported: new Set(names), private: new Set(privateNames),
      ordinals: new Map(names.map((name, i) => [name, BigInt(i + 1)])),
    });
  }

  const grants = new Set();
  const imports = new Map();
  for (const entry of importGrants) {
    const consumer = entry?.consumer;
    const provider = entry?.provider;
    const name = entry?.name;
    const c = byModule.get(consumer), p = byModule.get(provider);
    if (!c || !p || consumer === provider || typeof name !== 'string' ||
        !p.exported.has(name) || c.exported.has(name) || c.private.has(name)) {
      throw new Error('E_SYMBOL_IMPORT_DENIED: unresolvable or conflicting qualified import');
    }
    const key = keyOf(consumer, provider, name);
    const nameKey = keyOf(consumer, name);
    if (grants.has(key) || (imports.has(nameKey) && imports.get(nameKey) !== provider)) {
      throw new Error('E_SYMBOL_IMPORT_DENIED: duplicate or ambiguous import');
    }
    grants.add(key);
    imports.set(nameKey, provider);
  }

  // Canonical ASCII module names and compiler-sorted exports produce one
  // deterministic host ID per qualified declaration, independent of the order
  // in which modules are handed to the linker.
  const registry = createSymbolRegistry();
  const exports = new Map();
  try {
    for (const id of [...byModule.keys()].sort()) {
      for (const name of byModule.get(id).exported) {
        exports.set(keyOf(id, name), registry.internGlobal(id, name));
      }
    }
  } catch (error) {
    registry.close();
    throw error;
  }
  let closed = false;
  function active() {
    if (closed) throw new Error('E_SYMBOL_CLOSED: linker has been closed');
  }
  function qualified(provider, name) {
    active();
    return exports.get(keyOf(provider, name)) ?? null;
  }
  function authorized(consumer, handle) {
    active();
    if (!byModule.has(consumer)) return false;
    const resolved = registry.resolve(handle, SUPERVISOR_ISOLATE_ID);
    if (!resolved || resolved.scope !== 'global') return false;
    if (resolved.module === consumer) return true;
    return grants.has(keyOf(consumer, resolved.module, resolved.name));
  }
  return Object.freeze({
    /** Querying identity is not permission to import it. */
    exported(provider, name) { return qualified(provider, name); },
    /** Only an explicit host-trusted grant allows a qualified import. */
    imported(consumer, provider, name) {
      active();
      if (!grants.has(keyOf(consumer, provider, name))) {
        throw new Error('E_SYMBOL_IMPORT_DENIED: missing trusted qualified import grant');
      }
      return qualified(provider, name);
    },
    isAuthorized: authorized,
    /** Both sender and recipient must be allowed to reference this identity. */
    canTransport(sender, recipient, handle) {
      return authorized(sender, handle) && authorized(recipient, handle) &&
        registry.canTransport(handle, SUPERVISOR_ISOLATE_ID, SUPERVISOR_ISOLATE_ID);
    },
    same(left, right) { active(); return registry.same(left, right); },
    /** Positive guest ordinals are meaningful ONLY in their own compiled module. */
    ownGuestOrdinal(moduleId, handle) {
      active();
      const resolved = registry.resolve(handle, SUPERVISOR_ISOLATE_ID);
      return resolved && resolved.module === moduleId
        ? byModule.get(moduleId)?.ordinals.get(resolved.name) ?? null : null;
    },
    get moduleCount() { active(); return byModule.size; },
    get grantCount() { active(); return grants.size; },
    close() { if (!closed) { closed = true; registry.close(); } },
  });
}
