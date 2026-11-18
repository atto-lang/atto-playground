import test from 'node:test';
import assert from 'node:assert/strict';

// Exercise the production runner handler without mocking WebAssembly.
const MAGIC = [0, 97, 115, 109, 1, 0, 0, 0];
const bytes = Uint8Array.from([
  ...MAGIC,
  1, 5, 1, 0x60, 0, 1, 0x7e, // type () -> i64
  3, 2, 1, 0,                // one function
  7, 8, 1, 4, 109, 97, 105, 110, 0, 0, // export main
  10, 6, 1, 4, 0, 0x42, 42, 0x0b
]);
test('a disposable tenant Worker admits one guest across overlaps and never reads rejected payloads', async () => {
  assert.equal(WebAssembly.validate(bytes), true);
  const messages = [];
  const previous = globalThis.self;
  const scope = { onmessage: null, postMessage: message => messages.push(message) };
  globalThis.self = scope;
  try {
    await import('../src/runner-worker.js');
    let inspected = 0;
    const first = scope.onmessage({data:{wasm:bytes}});
    const second = scope.onmessage({ get data() { inspected++; throw new Error('reject must not read data'); } });
    await Promise.all([first, second]);
    assert.equal(inspected, 0);
    assert.equal(messages.length, 2);
    const allowed = messages.find(x => x.ok);
    const denied = messages.find(x => x.message?.startsWith('E_TENANT_REUSE:'));
    assert.equal(allowed?.value, '42');
    assert.deepEqual(denied, {
      ok:false, message:'E_TENANT_REUSE: disposable Worker already accepted a guest',
      stdout:'', truncated:false, actors:0
    });
    await scope.onmessage({data:{wasm:bytes}});
    assert.equal(messages[2]?.message, denied.message);
    assert.equal(messages[2]?.stdout, '');
  } finally {
    globalThis.self = previous;
  }
});
