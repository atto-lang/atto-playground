/* A single actor owns this dedicated browser Worker, Wasm instance, mailbox,
 * continuations and child tasks. The Promise chain is its non-reentrant
 * execution lease: suspending releases the browser carrier, NOT the actor
 * mailbox lease, until all nested awaits complete or the actor is cancelled.
 * No supervisor/CONTROL-pool code executes guest actor continuations. */
import { describePanic, guestImports } from './guest.js';
import { asyncGuestInfo, createAsyncTaskHost } from './task-host.js';

const out = { text: '', truncated: false };
let instance = null, type = -1, failed = false, generation = 0, nextSequence = 0, taskHost = null;
let chain = Promise.resolve();

self.onmessage = ({ data }) => {
  // Each message is appended to the actor-owned serial work queue. A suspended
  // handler prevents reentrance but not other actor Workers from progressing.
  chain = chain.then(() => handle(data));
};

async function handle(data) {
  if (failed) return;
  try {
    if (data?.kind === 'init' && !instance) {
      const wasm = data.wasm;
      if (!(wasm instanceof Uint8Array) || wasm.byteLength > 1 << 20 || !WebAssembly.validate(wasm)) throw Error('Invalid/oversized guest module');
      if (!Number.isInteger(data.type) || data.type < 0 ||
          !Number.isSafeInteger(data.generation) || data.generation < 1) throw Error('Invalid actor initialization');
      const module = await WebAssembly.compile(wasm);
      const async = asyncGuestInfo(module);
      if (async.enabled) taskHost = createAsyncTaskHost(module);
      const host = guestImports(module, out, null, taskHost);
      const created = await WebAssembly.instantiate(module, host.imports);
      host.bind(created);
      if (typeof created.exports.actor_init !== 'function' || typeof created.exports.actor_receive !== 'function') {
        throw Error('Guest actor exports missing');
      }
      taskHost?.bind(created);
      instance = created;
      type = data.type;
      generation = data.generation;
      instance.exports.actor_init(type);
      self.postMessage({ kind: 'ready', generation });
    } else if (data?.kind === 'mail' && instance) {
      if (data.generation !== generation) throw Error('E_ACTOR_STALE: mailbox generation mismatch');
      if (typeof data.value !== 'bigint' || data.sequence !== nextSequence) throw Error('E_ACTOR_PROTOCOL: invalid mail order');
      const activeGeneration = generation;
      out.text = '';
      out.truncated = false;
      if (taskHost) {
        await taskHost.runActorReceive(type, data.value, BigInt(data.sequence));
      } else {
        instance.exports.actor_receive(type, data.value, BigInt(data.sequence));
      }
      if (activeGeneration !== generation || failed) throw Error('E_ACTOR_STALE: completion from invalid generation');
      self.postMessage({ kind: 'done', generation, sequence: nextSequence, stdout: out.text, truncated: out.truncated });
      nextSequence++;
    } else {
      throw Error('E_ACTOR_PROTOCOL: unexpected actor worker command');
    }
  } catch (error) {
    failed = true;
    taskHost?.close();
    const message = instance ? describePanic(instance, error) : `E_RUNTIME: ${error.message}`;
    self.postMessage({ kind: 'fault', generation, message, stdout: out.text, truncated: out.truncated });
  }
}
