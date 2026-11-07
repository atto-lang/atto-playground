/** Minimal browser UI for the deliberately narrow scalar actor ABI.
 * Requires reviewed compiler bytes with compile_actor; never falls back to JS
 * interpretation or an ordinary main() guest.
 */
import { createActorSession, parseActorMessage } from './actor-session.js';

const ACTOR_EXAMPLE = `define actor Worker as
    receive(int value): int {
        return value + 1;
    }
end`;

export function installActorWorkbench({
  editor, startButton, sendButton, stopButton, exampleButton,
  messageInput, status, output, session = createActorSession(),
} = {}) {
  let generation = 0, busy = false, starting = false, sending = false;
  function render() {
    startButton.disabled = busy || starting || session.active;
    sendButton.disabled = busy || starting || sending || !session.active;
    stopButton.disabled = !(starting || session.active);
    messageInput.disabled = !session.active;
  }
  function line(message) {
    const text = String(message).slice(0, 1024);
    const full = output.textContent + text + '\n';
    output.textContent = full.length > 65536
      ? '[older actor output truncated]\n' + full.slice(-60000) : full;
  }
  function stop(note = 'Actor stopped') {
    ++generation;
    session.stop();
    starting = false;
    sending = false;
    status.textContent = note;
    render();
  }
  startButton.addEventListener('click', async () => {
    if (busy || starting || session.active) return;
    const run = ++generation;
    starting = true;
    status.textContent = 'Compiling actor in local Wasm…';
    output.textContent = '';
    render();
    try {
      const { wasm } = await session.start(editor.value);
      if (run !== generation) return;
      status.textContent = 'Actor ready (Web Worker)';
      line(`Actor compiled into ${wasm.length} Wasm bytes. Send a signed i64 message.`);
    } catch (error) {
      if (run !== generation) return;
      const message = error instanceof Error ? error.message : 'E_ACTOR_HOST: unexpected failure';
      status.textContent = 'Actor not started';
      line(message);
    } finally {
      if (run === generation) {
        starting = false;
        render();
      }
    }
  });
  sendButton.addEventListener('click', async () => {
    if (busy || starting || sending || !session.active) return;
    const run = generation;
    let value;
    try { value = parseActorMessage(messageInput.value); }
    catch (error) { line(error.message); return; }
    sending = true;
    render();
    try {
      const result = await session.send(value);
      if (run === generation) line(`receive(${value}) → ${result}`);
    } catch (error) {
      if (run === generation) {
        line(error.message);
        if (!session.active) stop('Actor terminated after failure');
      }
    } finally {
      if (run === generation) {
        sending = false;
        render();
      }
    }
  });
  stopButton.addEventListener('click', () => stop());
  exampleButton.addEventListener('click', () => {
    stop('Example loaded');
    editor.value = ACTOR_EXAMPLE;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
    status.textContent = 'Example loaded — compile actor to begin';
  });
  editor.addEventListener('input', () => {
    if (starting || session.active) stop('Source edited — previous actor terminated');
  });
  render();
  return Object.freeze({
    stop,
    setBusy(value) {
      busy = Boolean(value);
      if (busy && (starting || session.active)) stop('Actor stopped for program execution');
      render();
    },
  });
}
