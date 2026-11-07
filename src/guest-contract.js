/** Fail-closed M0 guest contract. Only type/function/export/code sections are allowed.
 * No start hook, memory, tables, globals, imports, data, or custom sections.
 * wasm validation alone does not enforce these absence requirements.
 */
export function validatedGuestModule(candidate) {
  if (!(candidate instanceof Uint8Array) && !(candidate instanceof ArrayBuffer)) {
    throw new TypeError('Guest must be Wasm bytes');
  }
  const bytes = candidate instanceof Uint8Array ? candidate : new Uint8Array(candidate);
  if (bytes.byteLength < 8 || bytes.byteLength > 65536) throw new Error('Invalid/oversized guest module');
  const magic = [0, 97, 115, 109, 1, 0, 0, 0];
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) throw new Error('Invalid guest Wasm header');
  }
  let cursor = 8;
  function varUint32() {
    let value = 0;
    let factor = 1;
    for (let i = 0; i < 5; i++) {
      if (cursor >= bytes.length) throw new Error('Truncated guest section size');
      const octet = bytes[cursor++];
      value += (octet & 127) * factor;
      if (value > 0xffffffff) throw new Error('Guest section size overflow');
      if (!(octet & 128)) return value;
      factor *= 128;
    }
    throw new Error('Invalid guest section size');
  }
  const allowedSections = [1, 3, 7, 10];
  let expected = 0;
  while (cursor < bytes.length) {
    const id = bytes[cursor++];
    if (id !== allowedSections[expected]) {
      throw new Error('Forbidden or out-of-order guest section: ' + id);
    }
    const length = varUint32();
    if (length > bytes.length - cursor) throw new Error('Truncated guest section');
    cursor += length;
    expected++;
  }
  if (expected !== allowedSections.length || !WebAssembly.validate(bytes)) {
    throw new Error('Invalid guest module structure');
  }
  const module = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(module).length) throw new Error('Guest imports are disabled');
  const exports = WebAssembly.Module.exports(module);
  if (exports.length !== 1 || exports[0].name !== 'main' || exports[0].kind !== 'function') {
    throw new Error('Guest export contract mismatch');
  }
  return module;
}
