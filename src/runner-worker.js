import { requireGuestAbiV2 } from './actor-abi-version.js';
/* Executes one guest module (contract atto.browser.guest.v2) in a fresh,
 * disposable worker. The parent enforces the wall-clock deadline by
 * terminating this worker, including all tenant-local actor instances.
 * The only capabilities granted are the atto.print_* output functions and,
 * for programs with actors, spawn/send through the bounded actor host. */
import { actorNames, describePanic, guestImports } from './guest.js';
import { createTenantActorHost } from './tenant-actor-host.js';
import { admitWasm32Memory } from './wasm-memory-admission.js';
import { asyncGuestInfo, createAsyncTaskHost } from './task-host.js';

self.onmessage = async ({ data }) => {
  const out = { text: '', truncated: false };
  let host = null;
  let taskHost = null;
  const reply = message => self.postMessage({ ...message, stdout: out.text, truncated: out.truncated, actors: host?.count ?? 0, cooperativeYields: taskHost?.cooperativeYields ?? 0 });
  try {
    const wasm = new Uint8Array(data.wasm);
    if (wasm.byteLength > 1 << 20 || !WebAssembly.validate(wasm)) throw new Error('Invalid/oversized guest module');
    admitWasm32Memory(wasm); // preflight before any guest memory exists
    const module = await WebAssembly.compile(wasm);
    requireGuestAbiV2(module);
    const names = actorNames(module);
    const asyncInfo = asyncGuestInfo(module);
    if (asyncInfo.enabled && names.length) throw new Error('E_ASYNC: tenant actors cannot share JSPI task frames');
    if (names.length) host = createTenantActorHost({ module, names, out });
    if (asyncInfo.enabled) taskHost = createAsyncTaskHost(module);
    const { imports, bind } = guestImports(module, out, host, taskHost);
    const instance = await WebAssembly.instantiate(module, imports);
    bind(instance);
    taskHost?.bind(instance);
    let result;
    try {
      result = taskHost ? await taskHost.runMain() : instance.exports.main();
    } catch (error) {
      host?.close();
      taskHost?.close();
      reply({ ok: false, message: describePanic(instance, error) });
      return;
    }
    if (typeof result !== 'bigint') throw new Error('Guest returned unexpected value');
    // main has returned: wait until every actor has handled all of its mail
    const fault = host ? await host.drain() : null;
    host?.close();
    taskHost?.close();
    if (fault) reply({ ok: false, message: fault, value: result.toString() });
    else reply({ ok: true, value: result.toString() });
  } catch (error) {
    host?.close();
    taskHost?.close();
    reply({ ok: false, message: /^E_[A-Z_]+: /.test(error?.message ?? '') ? error.message : `E_RUNTIME: ${error.message}` });
  }
};
