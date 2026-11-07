/** Source-compiled Wasm actors in dedicated browser workers (experimental).
 * Explicit compiler ABI detection avoids pretending inert define declarations
 * are executable. No JS interpretation of user source takes place here.
 */
import { createWorkerTask } from './worker-task.js';
import { spawnWasmActor } from './actor-runtime.js';
import { isI64, validateActorGuest } from './actor-abi.js';

export function parseActorI64(value) {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9][0-9]*)$/.test(value.trim())) {
    throw new TypeError('E_ACTOR_PAYLOAD: expected a decimal signed i64 integer');
  }
  const n = BigInt(value.trim());
  if (!isI64(n)) throw new RangeError('E_ACTOR_PAYLOAD: value outside signed i64 range');
  return n;
}

export function installActorPlayground({
  editor, input, startButton, sendButton, stopButton, result,
  compilerTask = createWorkerTask(), spawn = spawnWasmActor,
} = {}) {
  let generation = 0;
  let active = null;
  let starting = false;
  let busy = false;
  const update = () => {
    startButton.disabled = starting;
    sendButton.disabled = starting || !active || busy;
    stopButton.disabled = !starting && !active;
  };
  const say = message => { result.textContent = String(message).slice(0, 8192); };
  const retire = (message = 'Actor terminated.') => {
    generation++;
    compilerTask.cancel();
    active?.close();
    active = null;
    starting = false;
    busy = false;
    update();
    say(message);
  };
  const send = async () => {
    if (!active || starting || busy) return;
    let value;
    try { value = parseActorI64(input.value); }
    catch (e) { say(e.message); return; }
    busy = true; update();
    const actor = active;
    const ticket = generation;
    try {
      const received = await actor.send(value);
      if (ticket === generation && actor === active) say('receive(' + value + ') → ' + received);
    } catch (e) {
      if (ticket === generation && actor === active) retire('E_ACTOR_RUNTIME: ' + e.message);
    } finally {
      if (ticket === generation) { busy = false; update(); }
    }
  };
  const start = async () => {
    if (starting) return;
    // A new launch always fences old callbacks and stops the old worker.
    retire('Compiling actor source…');
    const ticket = generation;
    starting = true; update();
    try {
      const compiled = await compilerTask.request(
        new URL('./compiler-worker.js', import.meta.url),
        { source: editor.value, mode: 'actor' },
        10000, 'Actor compilation'
      );
      if (ticket !== generation) return;
      if (!compiled?.ok) {
        say(compiled?.diagnostics?.[0]?.message || 'E_ACTOR_COMPILE: no artifact generated');
        return;
      }
      validateActorGuest(compiled.wasm);
      const actor = await spawn(compiled.wasm, { timeoutMs: 3000 });
      if (ticket !== generation) { actor.close(); return; }
      active = actor;
      say('Actor ready in dedicated Web Worker. Send a signed i64 message.');
    } catch (e) {
      if (ticket === generation) say('E_ACTOR_START: ' + e.message);
    } finally {
      if (ticket === generation) { starting = false; update(); }
    }
  };
  startButton.addEventListener('click', start);
  sendButton.addEventListener('click', send);
  stopButton.addEventListener('click', () => retire());
  editor.addEventListener('input', () => {
    if (starting || active) retire('Actor stopped: source changed; compile again.');
  });
  update();
  return Object.freeze({ start, send, stop: retire, get running() { return !!active; } });
}

if (typeof document !== 'undefined') {
  installActorPlayground({
    editor: document.querySelector('#source'),
    input: document.querySelector('#actor-message'),
    startButton: document.querySelector('#actor-start'),
    sendButton: document.querySelector('#actor-send'),
    stopButton: document.querySelector('#actor-stop'),
    result: document.querySelector('#actor-result'),
  });
}
