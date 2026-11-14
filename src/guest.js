/** Host side of guest contract atto.browser.guest.v2 (see docs/COMPILER_CONTRACT.md). */
export const STDOUT_LIMIT = 64 * 1024;
const PRINT = new Set(['print_i64', 'print_bool', 'print_str', 'print_newline', 'print_f64']);
const ACTOR = new Set(['actor_spawn', 'actor_send']);
const ALLOWED_EXPORTS = new Set(['main', 'panic_code', 'memory', 'actor_init', 'actor_receive']);
export const MAX_ACTOR_TYPES = 256;
const ACTOR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Render a float exactly like Java Double.toString (JDK 19+: shortest
 *  round-trip digits, as ECMAScript); plain for 1e-3 <= |x| < 1e7 with at
 *  least one fraction digit, otherwise "d.dddE±n". */
export function formatJavaDouble(x) {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const abs = Math.abs(x);
  if (abs >= 1e-3 && abs < 1e7) {
    const text = String(x);
    return text.includes('.') ? text : text + '.0';
  }
  const [mantissa, exponent] = x.toExponential().split('e');
  return (mantissa.includes('.') ? mantissa : mantissa + '.0') + 'E' + exponent.replace('+', '');
}

/** Append guest output, capping it at STDOUT_LIMIT UTF-16 units without
 *  ever leaving half of a surrogate pair at the cut. */
export function appendCapped(out, text) {
  if (out.truncated) return;
  const room = STDOUT_LIMIT - out.text.length;
  if (text.length <= room) { out.text += text; return; }
  let cut = Math.max(0, room);
  if (cut > 0 && /[\uD800-\uDBFF]/.test(text[cut - 1])) cut--;
  out.text += text.slice(0, cut);
  out.truncated = true;
}

/** Actor type names from the `atto.actors` custom section (vec(name)), or
 *  [] for a program without actors. Malformed tables are rejected. */
export function actorNames(module) {
  const sections = WebAssembly.Module.customSections(module, 'atto.actors');
  const exports = WebAssembly.Module.exports(module);
  const hasActorExports = exports.some(e => e.name === 'actor_init' || e.name === 'actor_receive');
  if (!sections.length) {
    if (hasActorExports) throw new Error('Guest actor table missing');
    return [];
  }
  if (sections.length !== 1) throw new Error('Guest actor table duplicated');
  const bytes = new Uint8Array(sections[0]);
  let pos = 0;
  const leb = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (pos >= bytes.length) throw new Error('Guest actor table truncated');
      const b = bytes[pos++];
      value += (b & 127) * 2 ** shift;
      if (!(b & 128)) return value;
    }
    throw new Error('Guest actor table malformed');
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const count = leb();
  if (count < 1 || count > MAX_ACTOR_TYPES) throw new Error('Guest actor table size invalid');
  const names = [];
  for (let i = 0; i < count; i++) {
    const length = leb();
    if (pos + length > bytes.length) throw new Error('Guest actor table truncated');
    const name = decoder.decode(bytes.subarray(pos, pos + length));
    if (!ACTOR_NAME.test(name)) throw new Error('Guest actor name invalid');
    names.push(name);
    pos += length;
  }
  if (pos !== bytes.length) throw new Error('Guest actor table has trailing bytes');
  const fn = name => exports.find(e => e.name === name)?.kind === 'function';
  if (!fn('actor_init') || !fn('actor_receive')) throw new Error('Guest actor exports missing');
  return names;
}

/** Bounded, exact UTF-8 decoding of the additive v2 symbol manifests.
 *  These are type/identity declarations, never authorization capabilities. */
function readManifest(module, sectionName, limit, decodeEntry) {
  const sections = WebAssembly.Module.customSections(module, sectionName);
  if (!sections.length) return null;
  if (sections.length !== 1) throw new Error('E_SYMBOL_ABI: duplicate ' + sectionName);
  const bytes = new Uint8Array(sections[0]);
  if (bytes.length > 1 << 20) throw new Error('E_SYMBOL_LIMIT: oversized manifest');
  let pos = 0;
  function uleb() {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      if (pos >= bytes.length) throw new Error('E_SYMBOL_ABI: truncated manifest');
      const b = bytes[pos++];
      if (i === 4 && (b & 0xf0)) throw new Error('E_SYMBOL_ABI: oversized integer');
      value += (b & 0x7f) * 2 ** (i * 7);
      if (!(b & 0x80)) {
        if (i && b === 0) throw new Error('E_SYMBOL_ABI: noncanonical integer');
        return value;
      }
    }
    throw new Error('E_SYMBOL_ABI: invalid integer');
  }
  const count = uleb();
  if (count > limit) throw new Error('E_SYMBOL_LIMIT: too many manifest entries');
  const values = [];
  for (let i = 0; i < count; i++) values.push(decodeEntry({ bytes, uleb, position: () => pos,
    advance(n) { pos += n; } }));
  if (pos !== bytes.length) throw new Error('E_SYMBOL_ABI: trailing bytes');
  return Object.freeze(values);
}

/** Sorted public/global Symbol spellings, whose guest i64 IDs start at 1. */
export function symbolManifest(module) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let last = null;
  const names = readManifest(module, 'atto.symbols', 16_384, ctx => {
    const len = ctx.uleb();
    if (len < 2 || len > 4096 || ctx.position() + len > ctx.bytes.length) {
      throw new Error('E_SYMBOL_ABI: invalid symbol length');
    }
    const raw = ctx.bytes.subarray(ctx.position(), ctx.position() + len);
    if (last) {
      let order = 0;
      for (let i = 0; i < Math.min(last.length, raw.length); i++) {
        if (raw[i] !== last[i]) { order = raw[i] > last[i] ? 1 : -1; break; }
      }
      if (!order) order = Math.sign(raw.length - last.length);
      if (order <= 0) throw new Error('E_SYMBOL_ABI: symbols are unsorted or duplicate');
    }
    const name = decoder.decode(raw);
    if (!/^#[\\p{L}_][\\p{L}\\p{N}_]*$/u.test(name)) {
      throw new Error('E_SYMBOL_ABI: invalid symbol spelling');
    }
    last = raw.slice();
    ctx.advance(len);
    return name;
  });
  return names ?? Object.freeze([]);
}

/** Actor-specific payload kind: 0 absent, 1 int, 2 bool, 3 Symbol. */
export function actorMailKinds(module, actorCount, symbolCount = 0) {
  const kinds = readManifest(module, 'atto.actor_mail', 256, ctx => {
    if (ctx.position() >= ctx.bytes.length) throw new Error('E_SYMBOL_ABI: truncated actor types');
    const kind = ctx.bytes[ctx.position()];
    ctx.advance(1);
    if (kind > 3) throw new Error('E_SYMBOL_ABI: invalid actor mail kind');
    return kind;
  });
  if (!kinds) {
    if (symbolCount && actorCount) throw new Error('E_SYMBOL_ABI: missing typed actor mail manifest');
    return Object.freeze([]);
  }
  if (kinds.length !== actorCount || (kinds.includes(3) && !symbolCount)) {
    throw new Error('E_SYMBOL_ABI: actor message manifest mismatch');
  }
  return kinds;
}

/** Validate a guest module's interface and build its import object.
 *  `out` collects stdout as `{ text, truncated }`. `actors` supplies the
 *  `spawn(type)` / `send(ref, value)` capabilities; without it a guest that
 *  calls them traps. Call `bind(instance)` after instantiation so string
 *  printing can read guest memory. */
export function guestImports(module, out, actors = null) {
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.module !== 'atto' || imp.kind !== 'function' || !(PRINT.has(imp.name) || ACTOR.has(imp.name))) {
      throw new Error(`Guest import not granted: ${imp.module}.${imp.name}`);
    }
  }
  const exports = WebAssembly.Module.exports(module);
  const main = exports.find(e => e.name === 'main');
  if (!main || main.kind !== 'function' || exports.some(e => !ALLOWED_EXPORTS.has(e.name))) {
    throw new Error('Guest export contract mismatch');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let memory = null;
  const write = text => appendCapped(out, text);
  const denied = () => { throw new Error('E_ACTOR: actors cannot spawn or send in this context'); };

  const atto = {
    print_i64: value => write(String(value)),
    print_bool: value => write(value ? 'true' : 'false'),
    print_str: (ptr, len) => {
      if (!memory || ptr < 0 || len < 0 || ptr + len > memory.buffer.byteLength) throw new Error('print_str out of bounds');
      write(decoder.decode(new Uint8Array(memory.buffer, ptr, len)));
    },
    print_newline: () => write('\n'),
    print_f64: value => write(formatJavaDouble(value)),
    actor_spawn: actors ? type => actors.spawn(type) : denied,
    actor_send: actors ? (ref, value) => actors.send(ref, value) : denied,
  };
  return { imports: { atto }, bind: instance => { memory = instance.exports.memory ?? null; } };
}

/** Map a guest trap to a language-level message using the exported panic_code. */
export function describePanic(instance, error) {
  const code = instance.exports.panic_code?.value ?? 0;
  if (code === 1) return 'E_PANIC: integer overflow';
  if (code === 2) return 'E_PANIC: division by zero';
  if (code === 3) return 'E_PANIC: heap exhausted (objects and joined strings share a fixed 1 MiB heap)';
  if (error instanceof RangeError) return 'E_PANIC: stack exhausted (recursion too deep)';
  // host capability errors (actor limits) already carry their own code
  if (typeof error?.message === 'string' && /^E_[A-Z_]+: /.test(error.message)) return error.message;
  return `E_RUNTIME: ${error.message}`;
}
