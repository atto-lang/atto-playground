import test from 'node:test';
import assert from 'node:assert/strict';
import { asyncGuestInfo, createAsyncTaskHost } from '../src/task-host.js';
import { guestImports } from '../src/guest.js';
import { requireGuestAbiV2 } from '../src/actor-abi-version.js';

const leb = n => { const out=[]; do {let b=n&127; n>>>=7; out.push(n?b|128:b);} while(n); return out; };
const name = s => { const b=[...new TextEncoder().encode(s)]; return [...leb(b.length),...b]; };
const section = (id, b) => [id,...leb(b.length),...b];
function guest({asyncMarkers=[], actorTable=false, pipeline=false, actorVersion=null, cooperate=true}={}) {
  const types = section(1,[2,0x60,0,0,0x60,0,1,0x7e]); // ()->void; ()->i64
  const imports = cooperate ? section(2,[1,...name('atto'),...name('cooperate'),0,0]) : [];
  const funcs = section(3,[1,1]);
  const exports = section(7,[1,...name('main'),0,cooperate?1:0]);
  // i64.const 42; optionally call import 0; end
  const body=[0,0x42,42,...(cooperate?[0x10,0]:[]),0x0b];
  const code = section(10,[1,...leb(body.length),...body]);
  const customs=[
    ...asyncMarkers.flatMap(x=>section(0,[...name('atto.async'),...x])),
    ...(actorTable?[...section(0,[...name('atto.actors'),0])]:[]),
    ...(pipeline?[...section(0,[...name('atto.pipeline.v1'),1])]:[]),
    ...(actorVersion===null?[]:[...section(0,[...name('atto.actor.abi'),actorVersion,0])])
  ];
  const bytes = new Uint8Array([0,97,115,109,1,0,0,0,...types,...imports,...funcs,...exports,...code,...customs]);
  assert.equal(WebAssembly.validate(bytes),true,'real core Wasm fixture');
  return new WebAssembly.Module(bytes);
}

test('unmarked async imports never get a host capability',()=>{
  const module=guest();
  assert.throws(()=>asyncGuestInfo(module),/E_ASYNC: unmarked guest async capability/);
  assert.throws(()=>guestImports(module,{text:'',truncated:false}),/Guest import not granted/);
});

test('exact async/2 opts in, but draft actor v3 cannot be run by a v2 host',()=>{
  const module=guest({asyncMarkers:[[2]]});
  assert.deepEqual(asyncGuestInfo(module),{enabled:true});
  assert.equal(requireGuestAbiV2(module),2);
  const v3=guest({asyncMarkers:[[2]],actorVersion:3});
  assert.deepEqual(asyncGuestInfo(v3),{enabled:true});
  assert.throws(()=>requireGuestAbiV2(v3),/E_GUEST_ABI_UNSUPPORTED/);
});

test('unknown, duplicated, empty and trailing-byte async markers fail closed',()=>{
  for(const markers of [[[1]],[[3]],[[2,0]],[[]],[[2],[2]]]) {
    assert.throws(()=>asyncGuestInfo(guest({asyncMarkers:markers})),/E_ASYNC:/);
  }
});

test('mixing actor or pipeline capabilities into an async guest fails closed',()=>{
  for(const variant of [{actorTable:true},{pipeline:true}]) {
    assert.throws(()=>asyncGuestInfo(guest({asyncMarkers:[[2]],...variant})),/E_ASYNC: mixing actor/);
  }
});

test('marked module without async imports cannot acquire the JSPI host',()=>{
  assert.throws(()=>asyncGuestInfo(guest({asyncMarkers:[[2]],cooperate:false})),/E_ASYNC: inconsistent/);
});

test('JSPI either cooperates on a real Wasm stack or fails closed when host lacks support',async()=>{
  const module=guest({asyncMarkers:[[2]]});
  if(typeof WebAssembly.Suspending!=='function'||typeof WebAssembly.promising!=='function'){
    assert.throws(()=>createAsyncTaskHost(module),/E_ASYNC: this browser does not implement native Wasm JSPI/);
    return;
  }
  const host=createAsyncTaskHost(module);
  const out={text:'',truncated:false};
  const imports=guestImports(module,out,null,host);
  const instance=new WebAssembly.Instance(module,imports.imports);
  imports.bind(instance);host.bind(instance);
  assert.equal(await host.runMain(),42n);
  assert.equal(host.cooperativeYields,1);
});
