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
  const signatures = [], functionTypes = [];
  let exportedFunction = null;
  const take = (position, end) => {
    if (position.at >= end) throw new Error('Truncated actor function signature');
    return bytes[position.at++];
  };
  const length = (position, end) => {
    const n = readUleb(bytes, position);
    if (position.at > end) throw new Error('Truncated actor section length');
    return n;
  };
  while (cursor.at < bytes.length) {
    const id = bytes[cursor.at++];
    const size = readUleb(bytes, cursor);
    const end = cursor.at + size;
    if (end > bytes.length) throw new Error('Truncated Wasm section');
    // Deliberately no linear memory or host-calling table in this v0 ABI.
    if ([4, 5, 8, 9, 11, 12, 13].includes(id)) {
      throw new Error('Actor guest section not admitted: ' + id);
    }
    const p = { at: cursor.at };
    if (id === 1) {
      const count = length(p, end);
      if (count > 2048) throw new Error('Too many actor function types');
      for (let i = 0; i < count; i++) {
        if (take(p, end) !== 0x60) throw new Error('Actor ABI requires core function types');
        const params = [], results = [];
        const n = length(p, end);
        if (n > 32) throw new Error('Actor signature has too many parameters');
        for (let k = 0; k < n; k++) params.push(take(p, end));
        const m = length(p, end);
        if (m > 1) throw new Error('Actor signature has too many results');
        for (let k = 0; k < m; k++) results.push(take(p, end));
        if ([...params, ...results].some(v => v !== 0x7e && v !== 0x7f)) {
          throw new Error('Actor ABI allows only integer scalar types');
        }
        signatures.push({ params, results });
      }
    }
    if (id === 3) {
      const count = length(p, end);
      if (count > 2048) throw new Error('Too many actor functions');
      for (let i = 0; i < count; i++) functionTypes.push(length(p, end));
    }
    if (id === 7) {
      const count = length(p, end);
      if (count !== 1) throw new Error('Actor ABI requires exactly one export');
      const nameLength = length(p, end);
      if (nameLength > 64 || p.at + nameLength > end) throw new Error('Invalid actor export name');
      const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(p.at, p.at + nameLength));
      p.at += nameLength;
      const kind = take(p, end), index = length(p, end);
      if (name !== 'receive' || kind !== 0) throw new Error('Actor ABI requires receive function export');
      exportedFunction = index;
    }
    if ([1, 3, 7].includes(id) && p.at !== end) {
      throw new Error('Trailing actor ABI section bytes');
    }
    cursor.at = end;
  }
  const mod = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(mod).length !== 0) throw new Error('Actor guest must have zero imports');
  const exports = WebAssembly.Module.exports(mod);
  if (exports.length !== 1 || exports[0].name !== 'receive' || exports[0].kind !== 'function') {
    throw new Error('Actor guest must export only receive(i64)->i64');
  }
  // No imports means the Wasm function index maps directly to code-declared
  // functions. JS reflection exposes the export name but not its signature.
  const index = functionTypes[exportedFunction];
  const signature = signatures[index];
  if (!signature || signature.params.length !== 1 || signature.params[0] !== 0x7e ||
      signature.results.length !== 1 || signature.results[0] !== 0x7e) {
    throw new Error('Actor ABI requires receive(i64)->i64');
  }
  return mod;
}
