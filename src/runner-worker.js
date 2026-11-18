import { requireGuestAbiV2 } from './actor-abi-version.js';
/* Executes one guest module (contract atto.browser.guest.v2) in a fresh,
 * disposable worker. The parent enforces the wall-clock deadline by
 * terminating this worker, including all tenant-local actor instances.
 * The only capabilities granted are the atto.print_* output functions and,
 * for programs with actors, spawn/send through the bounded actor host. */
import { actorNames, describePanic, guestImports } from './guest.js';
import { createTenantActorHost } from './tenant-actor-host.js';
import { admitWasm32Memory } from './wasm-memory-admission.js';
import { validateGuestImportABI } from './guest-import-abi.js';

// A disposable tenant Worker must accept exactly one guest, including while
// compile/instantiate/drain awaits. The latch must precede payload access.
let acceptedOneGuest = false;
self.onmessage = async event => {
  if (acceptedOneGuest) {
    self.postMessage({
      ok: false, message: 'E_TENANT_REUSE: disposable Worker already accepted a guest',
      stdout: '', truncated: false, actors: 0
    });
    return;
  }
  acceptedOneGuest = true;
  const data = event.data;
  const out = { text: '', truncated: false };
  let host = null;
  const reply = message => self.postMessage({ ...message, stdout: out.text, truncated: out.truncated, actors: host?.count ?? 0 });
  try {
    const source = data?.wasm;
    if (!(source instanceof Uint8Array) && !(source instanceof ArrayBuffer)) {
      throw new Error('E_GUEST_ABI: guest bytes required');
    }
    const view = source instanceof ArrayBuffer ? new Uint8Array(source) : source;
    if (!(view.buffer instanceof ArrayBuffer)) {
      throw new Error('E_GUEST_ABI: shared guest bytes not admitted');
    }
    if (view.byteLength > (1 << 20)) throw new Error('Invalid/oversized guest module');
    // Snapshot the exact bytes we validate and compile; reject shared buffers.
    const wasm = new Uint8Array(view);
    if (!WebAssembly.validate(wasm)) throw new Error('Invalid/oversized guest module');
    admitWasm32Memory(wasm); // preflight before any guest memory exists
    const module = await WebAssembly.compile(wasm);
    requireGuestAbiV2(module);
    validateGuestImportABI(wasm, module, { allowFloat: true });
    const names = actorNames(module);
    if (names.length) host = createTenantActorHost({ module, names, out });
    const { imports, bind } = guestImports(module, out, host);
    const instance = await WebAssembly.instantiate(module, imports);
    bind(instance);
    let result;
    try {
      result = instance.exports.main();
    } catch (error) {
      host?.close();
      reply({ ok: false, message: describePanic(instance, error) });
      return;
    }
    if (typeof result !== 'bigint') throw new Error('Guest returned unexpected value');
    // main has returned: wait until every actor has handled all of its mail
    const fault = host ? await host.drain() : null;
    host?.close();
    if (fault) reply({ ok: false, message: fault, value: result.toString() });
    else reply({ ok: true, value: result.toString() });
  } catch (error) {
    host?.close();
    reply({ ok: false, message: /^E_[A-Z_]+: /.test(error?.message ?? '') ? error.message : `E_RUNTIME: ${error.message}` });
  }
};
