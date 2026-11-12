// The real compiler supplies an atto.async/2 Wasm module. We inject only
// the JSPI call wrappers so cancellation/interleaving can be tested under
// Node; actual stack suspension is separately verified in Chromium E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { createAsyncTaskHost } from '../src/task-host.js';

const compiler = await createCompiler(await readFile(new URL('../public/atto_compiler.wasm', import.meta.url)));
const compiled = compiler.compile(`pub suspends fnc main(): int {
  val a = task { await rt.barrier(2); return 20; };
  return await a;
}`);
assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
const module = await WebAssembly.compile(compiled.wasm);

const jspi = {
  Suspending: class { constructor(fn) { return fn; } },
  promising: fn => fn,
};
function bind({main=async()=>42n,task_invoke=async()=>20n,maxTasks=64,maxYields=32}={}) {
  const host = createAsyncTaskHost(module,{maxTasks,maxYields,jspi});
  host.bind({exports:{main,task_invoke,actor_receive:async()=>{}}});
  return host;
}

test('cancel an unmatched barrier without leaving a forever-pending waiter',async()=>{
  const host=bind();
  const pending=host.imports.barrier(2n);
  const rejected=assert.rejects(pending,/E_ASYNC: task scope cancelled/);
  host.close();
  await rejected;
});

test('cancel a paired barrier before its microtask resumes either continuation',async()=>{
  const host=bind();
  const left=host.imports.barrier(2n);
  const right=host.imports.barrier(2n);
  const both=Promise.all([
    assert.rejects(left,/E_ASYNC: task scope cancelled/),
    assert.rejects(right,/E_ASYNC: task scope cancelled/),
  ]);
  host.close();
  await both;
});

test('a consumed but pending Future still consumes quota and is cancelled exactly once',async()=>{
  let finishChild;
  const child=new Promise(resolve=>{finishChild=resolve;});
  const host=bind({maxTasks:1,task_invoke:async()=>child});
  const handle=host.imports.task_start(0);
  const result=host.imports.task_await(handle);
  const rejected=assert.rejects(result,/E_ASYNC: task scope cancelled/);
  await Promise.resolve(); // schedule compiler-generated task entrypoint
  assert.throws(()=>host.imports.task_start(0),/task quota exhausted/);
  assert.rejects(host.imports.task_await(handle),/already-consumed/);
  host.close();
  finishChild(20n); // late task settlement cannot revive the consumed handle
  await rejected;
  assert.throws(()=>host.imports.task_start(0),/scope closed/);
});

test('a settled consumed Future frees quota, but never permits double consumption',async()=>{
  const host=bind({maxTasks:1});
  const first=host.imports.task_start(0);
  assert.equal(await host.imports.task_await(first),20n);
  const next=host.imports.task_start(0);
  assert.notEqual(next,first);
  assert.equal(await host.imports.task_await(next),20n);
  await assert.rejects(host.imports.task_await(first),/already-consumed/);
  host.close();
});

test('runMain rejects detached child task before allowing owner scope to escape',async()=>{
  const host=bind();
  host.imports.task_start(0);
  await assert.rejects(host.runMain(),/detached task or unawaited Future/);
  assert.throws(()=>host.imports.task_start(0),/scope closed/);
});

test('cooperative yield quota is enforced for ready await sites',async()=>{
  const host=bind({maxYields:1});
  await host.imports.cooperate();
  assert.equal(host.cooperativeYields,1);
  await assert.rejects(host.imports.cooperate(),/yield quota exhausted/);
  host.close();
});
