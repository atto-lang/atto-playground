import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkerTask } from '../src/worker-task.js';

class FakeWorker {
  static instances = [];
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.terminated = 0;
    FakeWorker.instances.push(this);
  }
  postMessage(payload) {
    this.payload = payload;
    if (payload?.throwOnSend) throw new Error('DataCloneError');
  }
  terminate() { this.terminated++; }
  reply(data) { this.onmessage?.({ data }); }
  fail() { this.onerror?.(); }
  failDecode() { this.onmessageerror?.(); }
}
function harness() {
  FakeWorker.instances = [];
  return { task: createWorkerTask({ WorkerImpl: FakeWorker }), workers: FakeWorker.instances };
}
test('worker success settles and releases resources exactly once', async () => {
  const { task, workers } = harness();
  const promise = task.request('./worker.js', { source: '42' }, 1000);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].options.type, 'module');
  workers[0].reply({ ok: true, value: 42 });
  assert.deepEqual(await promise, { ok: true, value: 42 });
  assert.equal(workers[0].terminated, 1);
  assert.equal(task.cancel(), false);
  workers[0].reply({ ok: false });
  assert.equal(workers[0].terminated, 1);
});
test('Stop rejects immediately and stale messages cannot affect the next run', async () => {
  const { task, workers } = harness();
  const first = task.request('./compiler-worker.js', { source: 'long job' }, 1000);
  const oldWorker = workers[0];
  const staleCallback = oldWorker.onmessage;
  assert.equal(task.cancel(), true);
  await assert.rejects(first, /Operation cancelled/);
  assert.equal(oldWorker.terminated, 1);
  const second = task.request('./compiler-worker.js', { source: 'new job' }, 1000);
  staleCallback({ data: { ok: true, value: -1 } });
  assert.equal(workers[1].terminated, 0);
  workers[1].reply({ ok: true, value: 42 });
  assert.deepEqual(await second, { ok: true, value: 42 });
  assert.equal(workers[1].terminated, 1);
});
test('a concurrent request is forbidden and does not replace the live worker', async () => {
  const { task, workers } = harness();
  const first = task.request('./worker.js', {}, 1000);
  assert.throws(() => task.request('./worker.js', {}, 1000), /already active/);
  assert.equal(workers.length, 1);
  task.cancel();
  await assert.rejects(first, /cancelled/);
});
test('worker execution and message decoding errors reject and terminate', async () => {
  for (const [event, expected] of [['fail', /failed to load/], ['failDecode', /decoded/]]) {
    const { task, workers } = harness();
    const promise = task.request('./worker.js', {}, 1000);
    workers[0][event]();
    await assert.rejects(promise, expected);
    assert.equal(workers[0].terminated, 1);
  }
});
test('invalid payload / structured clone failure rejects with cleanup', async () => {
  const { task, workers } = harness();
  await assert.rejects(task.request('./worker.js', { throwOnSend: true }, 1000), /DataCloneError/);
  assert.equal(workers[0].terminated, 1);
  assert.equal(task.cancel(), false);
});
test('deadline terminates the worker and rejects once', async () => {
  const { task, workers } = harness();
  await assert.rejects(task.request('./worker.js', {}, 5), /deadline exceeded/);
  assert.equal(workers[0].terminated, 1);
  assert.equal(task.cancel(), false);
});
test('deadline error names the phase that timed out', async () => {
  const { task } = harness();
  await assert.rejects(task.request('./worker.js', {}, 5, 'Compilation'), /^Error: Compilation deadline exceeded$/);
});

test('invalid deadline rejected before worker allocation', () => {
  const { task, workers } = harness();
  for (const value of [0, -1, NaN, Infinity]) {
    assert.throws(() => task.request('./worker.js', {}, value), RangeError);
  }
  assert.equal(workers.length, 0);
});

test('throwing Worker.terminate cannot strand successful replies or cancel and deadline rejection', async () => {
  FakeWorker.instances = [];
  class BrokenTerminateWorker extends FakeWorker {
    terminate() { super.terminate(); throw new Error('injected termination failure'); }
  }
  const task = createWorkerTask({ WorkerImpl: BrokenTerminateWorker });
  const first = task.request('./worker.js', {kind:'first'}, 1000);
  FakeWorker.instances[0].reply({ok:true,value:42});
  assert.deepEqual(await first, {ok:true,value:42});
  assert.equal(task.cancel(), false);
  const second = task.request('./worker.js', {kind:'second'}, 1000);
  assert.equal(task.cancel(), true);
  await assert.rejects(second, /Operation cancelled/);
  const third = task.request('./worker.js', {kind:'third'}, 5, 'Actor compilation');
  await assert.rejects(third, /Actor compilation deadline exceeded/);
  assert.deepEqual(FakeWorker.instances.map(w=>w.terminated), [1,1,1]);
  assert.equal(task.cancel(), false);
});

test('timer registration failure rejects and releases worker without sending payload', async () => {
  FakeWorker.instances = [];
  const task=createWorkerTask({
    WorkerImpl:FakeWorker,
    setTimer(){throw Error('injected timer allocation failure');},
  });
  await assert.rejects(task.request('./worker.js',{secret:'should-not-send'},10),/timer allocation failure/);
  assert.equal(FakeWorker.instances.length,1);
  assert.equal(FakeWorker.instances[0].terminated,1);
  assert.equal(FakeWorker.instances[0].payload,undefined);
  assert.equal(task.cancel(),false);
});

test('throwing terminate cannot hide structured-clone or worker error', async () => {
  FakeWorker.instances = [];
  class BrokenTerminateWorker extends FakeWorker {
    terminate() { super.terminate(); throw Error('termination failure'); }
  }
  const task=createWorkerTask({WorkerImpl:BrokenTerminateWorker});
  await assert.rejects(task.request('./worker.js',{throwOnSend:true},1000),/DataCloneError/);
  const pending=task.request('./worker.js',{},1000);
  FakeWorker.instances[1].failDecode();
  await assert.rejects(pending,/Worker response could not be decoded/);
  assert.deepEqual(FakeWorker.instances.map(w=>w.terminated),[1,1]);
  assert.equal(task.cancel(),false);
});

test('synchronous timer expiry never sends the cancelled worker payload', async () => {
  FakeWorker.instances = [];
  const task = createWorkerTask({
    WorkerImpl: FakeWorker,
    setTimer(callback) { callback(); return {key:'already-expired'}; },
    clearTimer() {},
  });
  await assert.rejects(task.request('./compiler-worker.js',{kind:'actor',source:'secret'},1000),
    /Execution deadline exceeded/);
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(FakeWorker.instances[0].terminated, 1);
  assert.equal(FakeWorker.instances[0].payload, undefined,
    'expired work must never reach the worker');
  assert.equal(task.cancel(), false);
});

test('throwing clearTimer preserves completion, cancellation and subsequent worker admission', async () => {
  FakeWorker.instances = [];
  let clears = 0;
  const task = createWorkerTask({
    WorkerImpl: FakeWorker,
    clearTimer() {clears++;throw new Error('injected timer cleanup failure');},
  });
  const first = task.request('./compiler-worker.js',{kind:'first'},1000);
  FakeWorker.instances[0].reply({ok:true,value:42});
  assert.deepEqual(await first,{ok:true,value:42});
  const second = task.request('./compiler-worker.js',{kind:'second'},1000);
  assert.equal(task.cancel(),true);
  await assert.rejects(second,/Operation cancelled/);
  const third = task.request('./compiler-worker.js',{kind:'third'},1000);
  FakeWorker.instances[2].failDecode();
  await assert.rejects(third,/Worker response could not be decoded/);
  assert.deepEqual(FakeWorker.instances.map(w=>w.terminated),[1,1,1]);
  assert.ok(clears>=3,'each settlement attempted timer cleanup');
  assert.equal(task.cancel(),false);
});
