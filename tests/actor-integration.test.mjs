import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { parseActorI64, installActorPlayground } from '../src/actor-playground.js';
import { validateActorGuest } from '../src/actor-abi.js';

const actorSource = 'define actor Worker as receive(int value): int { return value + 2; } end';

test('signed-i64 actor payload parsing is strict and bounded', () => {
  for (const [text, expected] of [['0',0n], ['-1',-1n],['40',40n],
    ['-9223372036854775808',-(1n<<63n)],['9223372036854775807',(1n<<63n)-1n]]) {
    assert.equal(parseActorI64(text), expected);
  }
  for (const x of ['','+1','1.0','01','0x10','NaN','1e3','9223372036854775808',
    '-9223372036854775809','123abc',null,1]) {
    assert.throws(() => parseActorI64(x), String(x));
  }
});

test('compiler bridge fails closed until actor-capable artifact is vendored', async () => {
  const bytes = await readFile(new URL('../public/atto_compiler.wasm', import.meta.url));
  const compiler = await createCompiler(bytes);
  const result = compiler.compileActor(actorSource);
  if (!compiler.hasActorCompiler) {
    assert.equal(result.ok, false);
    assert.match(result.diagnostics[0].message, /^E_UNSUPPORTED_ACTOR:/);
    assert.equal('wasm' in result, false);
  } else {
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    const module = validateActorGuest(result.wasm);
    assert.deepEqual(WebAssembly.Module.imports(module), []);
    const instance = await WebAssembly.instantiate(module, {});
    assert.equal(instance.exports.receive(40n), 42n);
  }
});

test('actor controller fences a cancelled compile and cannot resurrect an actor', async () => {
  function control() {
    return { disabled: false, handlers: new Map(),
      addEventListener(name, fn) { this.handlers.set(name, fn); } };
  }
  const editor = control(); editor.value = actorSource;
  const input = control(); input.value = '40';
  const startButton = control(), sendButton = control(), stopButton = control();
  const result = { textContent: '' };
  let resolveCompile;
  const task = { cancel() {}, request() { return new Promise(resolve => { resolveCompile = resolve; }); } };
  let spawns = 0;
  const app = installActorPlayground({editor,input,startButton,sendButton,stopButton,result,
    compilerTask: task, spawn: async () => {spawns++; return {close(){},send(){return Promise.resolve(42n)}};}});
  const started = app.start();
  assert.equal(stopButton.disabled, false);
  editor.handlers.get('input')();
  resolveCompile({ok:false,diagnostics:[{message:'late error'}]});
  await started;
  assert.equal(spawns,0);
  assert.equal(app.running,false);
  assert.match(result.textContent,/source changed/);
});

test('actor controller never starts a worker on a compilation diagnostic', async () => {
  function control(){return {disabled:false,addEventListener(){}};}
  const editor=control();editor.value=actorSource;
  const input=control();input.value='40';
  const result={textContent:''};
  let spawns=0;
  const app=installActorPlayground({editor,input,startButton:control(),sendButton:control(),
    stopButton:control(),result,
    compilerTask:{cancel(){},async request(){return {ok:false,diagnostics:[{message:'E_UNSUPPORTED_ACTOR: no compiler'}]};}},
    spawn:async()=>{spawns++;throw new Error('should not spawn');}});
  await app.start();
  assert.equal(spawns,0);
  assert.equal(app.running,false);
  assert.match(result.textContent,/E_UNSUPPORTED_ACTOR/);
});
