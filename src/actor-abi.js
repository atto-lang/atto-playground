/** Narrow source-free browser actor guest ABI, NOT full AttoLang actor lowering.
 * V0: a Wasm module exports only receive(i64)->i64; one module instance per
 * worker retains its private mutable globals between messages.
 * No imports, tables, linear memory, start functions or host capabilities.
 */
export const ACTOR_ABI = 'atto.browser.actor.scalar.v0';
export const ACTOR_MAX_WASM_BYTES = 1 << 20;
export const ACTOR_MAX_MAILBOX = 32;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;

export function isI64(x) {
  return typeof x === 'bigint' && x >= I64_MIN && x <= I64_MAX;
}

// Parse the well-formed module envelope to deny hidden memory/start/table
// sections. Validation by WebAssembly.validate follows before instantiation.
function readUleb(bytes, cursor) {
  let n = 0;
  for (let i = 0; i < 5; i++) {
    if (cursor.at >= bytes.length) throw new Error('Truncated Wasm section');
    const b = bytes[cursor.at++];
    n += (b & 127) * 2 ** (7 * i);
    if (!(b & 128)) {
      if (!Number.isSafeInteger(n)) throw new Error('Oversized Wasm section');
      return n;
    }
  }
  throw new Error('Invalid Wasm section length');
}
export function validateActorGuest(bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.byteLength > ACTOR_MAX_WASM_BYTES) {
    throw new Error('Invalid or oversized actor guest');
  }
  if (!WebAssembly.validate(bytes)) throw new Error('Invalid actor Wasm');
  const cursor = { at: 8 };
  while (cursor.at < bytes.length) {
    const id = bytes[cursor.at++];
    const size = readUleb(bytes, cursor);
    const end = cursor.at + size;
    if (end > bytes.length) throw new Error('Truncated Wasm section');
    // Deliberately no linear memory or host-calling table in this v0 ABI.
    if ([4, 5, 8, 9, 11, 12, 13].includes(id)) {
      throw new Error('Actor guest section not admitted: ' + id);
    }
    cursor.at = end;
  }
  const mod = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(mod).length !== 0) throw new Error('Actor guest must have zero imports');
  const exports = WebAssembly.Module.exports(mod);
  if (exports.length !== 1 || exports[0].name !== 'receive' || exports[0].kind !== 'function') {
    throw new Error('Actor guest must export only receive(i64)->i64');
  }
  return mod;
}
