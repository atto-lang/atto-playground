import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { createAuthorizedSymbolLinker } from '../src/symbol-linker.js';

const compiler = await createCompiler(await readFile(new URL('../public/atto_compiler.wasm', import.meta.url)));
function moduleOf(source) {
  const r = compiler.compile(source);
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return new WebAssembly.Module(r.wasm);
}
const provider = () => moduleOf('define pub symbol #ready; pub fnc main(): int { if #ready eq #ready then return 42; fi return 0; }');
const consumer = () => moduleOf('pub fnc main(): int { return 0; }');

test('one qualified exported identity is shared across two explicitly authorized importing modules', () => {
  const events=provider(), other=provider(), a=consumer(), b=consumer();
  const link=createAuthorizedSymbolLinker({
    modules:[
      {id:'app.worker_b', module:b}, {id:'app.other', module:other},
      {id:'app.events', module:events}, {id:'app.worker_a', module:a}
    ],
    importGrants:[
      {consumer:'app.worker_a',provider:'app.events',name:'#ready'},
      {consumer:'app.worker_b',provider:'app.events',name:'#ready'}
    ]
  });
  const original=link.exported('app.events','#ready');
  const importedA=link.imported('app.worker_a','app.events','#ready');
  const importedB=link.imported('app.worker_b','app.events','#ready');
  const unrelated=link.exported('app.other','#ready');
  assert.equal(link.moduleCount,4);
  assert.equal(link.grantCount,2);
  assert.equal(link.same(importedA,original),true);
  assert.equal(link.same(importedB,structuredClone(original)),true);
  assert.equal(link.same(unrelated,original),false,'same spelling from different canonical module');
  assert.equal(link.ownGuestOrdinal('app.events',original),1n);
  assert.equal(link.ownGuestOrdinal('app.other',original),null);
  assert.equal(link.ownGuestOrdinal('app.worker_a',original),null,
    'host import grant is NOT a compiled guest relocation');
  assert.equal(link.canTransport('app.worker_a','app.worker_b',original),true);
  assert.equal(link.canTransport('app.other','app.worker_a',unrelated),false);
  assert.equal(link.canTransport('app.worker_a','app.worker_b',unrelated),false);
  assert.equal(link.isAuthorized('app.worker_a',unrelated),false);
  assert.throws(()=>link.imported('app.worker_a','app.other','#ready'),/E_SYMBOL_IMPORT_DENIED/);
  assert.throws(()=>link.imported('app.worker_b','app.other','#ready'),/E_SYMBOL_IMPORT_DENIED/);
  assert.equal(link.exported('app.events','#unknown'),null);
  link.close();
  assert.throws(()=>link.imported('app.worker_a','app.events','#ready'),/E_SYMBOL_CLOSED/);
});

test('linker rejects forged, ambiguous, duplicate, conflicting and private imports', () => {
  const events=provider(), consumerM=consumer();
  const mods=[{id:'app.events',module:events},{id:'app.worker',module:consumerM}];
  const grant={consumer:'app.worker',provider:'app.events',name:'#ready'};
  const bad=grants=>createAuthorizedSymbolLinker({modules:mods,importGrants:grants});
  assert.throws(()=>bad([{...grant,name:'#private'}]),/E_SYMBOL_IMPORT_DENIED/);
  assert.throws(()=>bad([grant,grant]),/E_SYMBOL_IMPORT_DENIED/);
  assert.throws(()=>bad([{...grant,consumer:'app.unknown'}]),/E_SYMBOL_IMPORT_DENIED/);
  assert.throws(()=>bad([{...grant,consumer:'app.events'}]),/E_SYMBOL_IMPORT_DENIED/);
  assert.throws(()=>createAuthorizedSymbolLinker({modules:[mods[0],mods[0]]}),/E_SYMBOL_LINK/);
  assert.throws(()=>createAuthorizedSymbolLinker({modules:[{...mods[0],id:'../events'}]}),/E_SYMBOL_LINK/);

  const other=provider();
  assert.throws(()=>createAuthorizedSymbolLinker({
    modules:[...mods,{id:'app.other',module:other}],
    importGrants:[grant,{consumer:'app.worker',provider:'app.other',name:'#ready'}]
  }),/E_SYMBOL_IMPORT_DENIED/,'imported spelling is ambiguous across owners');

  const priv=moduleOf('define symbol #secret; pub fnc main(): int { if #secret eq #secret then return 1; fi return 0; }');
  assert.throws(()=>createAuthorizedSymbolLinker({
    modules:[...mods,{id:'app.private',module:priv}],
    importGrants:[{consumer:'app.worker',provider:'app.private',name:'#secret'}]
  }),/E_SYMBOL_IMPORT_DENIED/,'private symbols cannot be imported');

  const conflicting=moduleOf('define symbol #ready; pub fnc main(): int { return 0; }');
  assert.throws(()=>createAuthorizedSymbolLinker({
    modules:[mods[0],{id:'app.worker',module:conflicting}],
    importGrants:[grant]
  }),/E_SYMBOL_IMPORT_DENIED/,'private spellings cannot be shadowed by imported identities');

  const shadow=moduleOf('define pub symbol #ready; pub fnc main(): int { return 0; }');
  assert.throws(()=>createAuthorizedSymbolLinker({
    modules:[mods[0],{id:'app.worker',module:shadow}],
    importGrants:[grant]
  }),/E_SYMBOL_IMPORT_DENIED/,'a new public declaration is not an import');
});

test('module registration ordering does not alter canonical identity allocation', () => {
  const a=provider(),b=provider();
  const one=createAuthorizedSymbolLinker({modules:[{id:'a.events',module:a},{id:'b.events',module:b}]});
  const two=createAuthorizedSymbolLinker({modules:[{id:'b.events',module:b},{id:'a.events',module:a}]});
  assert.equal(one.exported('a.events','#ready').id,1n);
  assert.equal(two.exported('a.events','#ready').id,1n);
  assert.equal(one.exported('b.events','#ready').id,2n);
  assert.equal(two.exported('b.events','#ready').id,2n);
  assert.equal(one.same(one.exported('a.events','#ready'),two.exported('a.events','#ready')),false,
    'separate tenant linker registries are intentionally not interoperable');
  one.close();
  two.close();
});
