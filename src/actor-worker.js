/** One dedicated Web Worker = one isolated Wasm instance and FIFO mailbox.
 * This is a scheduling/heap separation, NOT an OS or origin security sandbox.
 * Only a static same-origin worker runs JS; guest Wasm has zero imports.
 */
import { isI64, validateActorGuest } from './actor-abi.js';

let instance = null;
let starting = false;
function terminal(message) {
  try { self.postMessage({ kind: 'fault', message: String(message).slice(0, 512) }); }
  finally { self.close(); }
}
self.onmessage = async ({ data }) => {
  if (!instance) {
    if (starting || data?.kind !== 'init') return terminal('E_ACTOR_PROTOCOL: expected single init');
    starting = true;
    try {
      const bytes = data.wasm;
      const mod = validateActorGuest(bytes);
      instance = await WebAssembly.instantiate(mod, {});
      self.postMessage({ kind: 'ready' });
    } catch (error) {
      terminal('E_ACTOR_INIT: ' + error.message);
    }
    return;
  }
  if (data?.kind !== 'message' || !Number.isSafeInteger(data.id) || data.id <= 0 || !isI64(data.value)) {
    return terminal('E_ACTOR_PROTOCOL: invalid message');
  }
  try {
    // Synchronous guest execution makes each worker's mailbox single-writer,
    // sequential and FIFO. Termination from the host stops non-cooperative code.
    const value = instance.exports.receive(data.value);
    if (!isI64(value)) throw new Error('receive must return signed i64');
    self.postMessage({ kind: 'result', id: data.id, value });
  } catch (error) {
    terminal('E_ACTOR_PANIC: ' + error.message);
  }
};
