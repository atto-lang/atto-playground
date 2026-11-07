/* Guest must be a bounded, import-free M0 Wasm module.
 * A fresh worker and parent-side deadline bound guest execution.
 */
import { validatedGuestModule } from './guest-contract.js';

self.onmessage = async ({ data }) => {
  try {
    const module = validatedGuestModule(data?.wasm);
    const instance = await WebAssembly.instantiate(module, {});
    const result = instance.exports.main();
    if (!Number.isInteger(result)) throw new Error('Guest returned unexpected value');
    self.postMessage({ ok: true, value: result });
  } catch (error) {
    self.postMessage({ ok: false, message: 'E_RUNTIME: ' + error.message });
  }
};
