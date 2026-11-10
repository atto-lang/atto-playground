// Generation and lifecycle adversarial checks against a real compiler guest
// and a deterministic mock-worker transport. Browser Worker execution is
// independently exercised by tests/browser-e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { createActorHost } from '../src/actor-host.js';
import { actorNames } from '../src/guest.js';

const compiler=await createCompiler(await readFile(new URL('../public/atto_compiler.wasm',import.meta.url)));
const source=`define actor AuditActor as
  receive(ActorMail<int> mail): void { stdio.println(mail.value); return; }
end
pub fnc main(): int { val x=spawn AuditActor(); return 0; }`;
const result=compiler.compile(source);
assert.equal(result.ok,true,JSON.stringify(result.diagnostics));
const module=await WebAssembly.compile(result.wasm);
class Transport {
  static all=[];
  constructor(){this.sent=[];this.terminated=0;Transport.all.push(this);}
  postMessage(data){this.sent.push(structuredClone(data));}
  terminate(){this.terminated++;}
  emit(data){this.onmessage?.({data});}
  ready(){this.emit({kind:'ready'});}
  done(sequence,stdout=''){this.emit({kind:'done',sequence,stdout,truncated:false});}
}
function setup(overrides={}){
  Transport.all=[];
  const out={text:'',truncated:false};
  const host=createActorHost({wasm:result.wasm,names:actorNames(module),out,WorkerImpl:Transport,workerUrl:'actor-worker.js',...overrides});
  return {host,out};
}

test('malformed done cannot smuggle stdout, truncated flag or consume pending credit',async()=>{
  const {host,out}=setup();
  const ref=host.spawn(0),worker=Transport.all[0];
  worker.ready();host.send(ref,1n);
  worker.emit({kind:'done',sequence:9,stdout:'SPOOFED OUTPUT',truncated:true});
  assert.equal(out.text,'');
  assert.equal(out.truncated,false);
  assert.equal(host.stats.pendingMessages,1);
  assert.match(await host.drain(),/E_ACTOR_PROTOCOL/);
  host.close();
});

test('ready replies cannot inject arbitrary stdout or truncated flags',async()=>{
  const {host,out}=setup();
  host.spawn(0);const worker=Transport.all[0];
  worker.emit({kind:'ready',stdout:'SPOOFED READY',truncated:true});
  assert.equal(out.text,'');
  assert.equal(out.truncated,false);
  assert.equal(await host.drain(),null);
  host.close();
});

test('genuine fault preserves prior guest output and seals the host to further commands',async()=>{
  const {host,out}=setup();
  const ref=host.spawn(0),worker=Transport.all[0];
  worker.ready();host.send(ref,1n);
  worker.emit({kind:'fault',message:'E_PANIC: guest trap',stdout:'prior output\\n',truncated:false});
  assert.equal(out.text,'prior output\\n');
  assert.throws(()=>host.send(ref,3n),/E_ACTOR_FAILED/);
  assert.throws(()=>host.spawn(0),/E_ACTOR_FAILED/);
  assert.throws(()=>host.restart(ref),/E_ACTOR_FAILED/);
  assert.match(await host.drain(),/E_PANIC: guest trap/);
  host.close();
});

test('drain admission seals all new spawns, sends and restarts even before completion',async()=>{
  const {host}=setup();
  const ref=host.spawn(0),worker=Transport.all[0];worker.ready();
  const draining=host.drain();
  assert.throws(()=>host.send(ref,2n),/E_ACTOR_FINALIZED/);
  assert.throws(()=>host.spawn(0),/E_ACTOR_FINALIZED/);
  assert.throws(()=>host.restart(ref),/E_ACTOR_RESTART_CLOSED/);
  assert.equal(await draining,null);
  host.close();
});

test('queued drain while mailbox pending rejects restart and preserves its accounting',async()=>{
  const {host}=setup();
  const ref=host.spawn(0),worker=Transport.all[0];
  worker.ready();host.send(ref,5n);
  const draining=host.drain();
  assert.throws(()=>host.restart(ref),/E_ACTOR_RESTART_CLOSED/);
  assert.equal(host.stats.pendingMessages,1);
  worker.done(0,'5\\n');
  assert.equal(await draining,null);
  assert.equal(host.stats.pendingMessages,0);
  host.close();
});

test('captured callbacks from prior generation cannot inject stdout, faults or acknowledgments',async()=>{
  const {host,out}=setup();
  const old=host.spawn(0),w0=Transport.all[0];w0.ready();
  const lateOnMessage=w0.onmessage,lateOnError=w0.onerror,lateOnMessageError=w0.onmessageerror;
  const next=host.restart(old),w1=Transport.all[1];w1.ready();
  host.send(next,9n);
  // These callbacks were queued *before* detachment and retain the old closure.
  lateOnMessage({data:{kind:'done',sequence:0,stdout:'OLD GENERATION',truncated:true}});
  lateOnMessage({data:{kind:'fault',message:'E_PANIC: old failure',stdout:'OLD FAILURE'}});
  lateOnError({preventDefault(){}});
  lateOnMessageError();
  assert.equal(host.stats.pendingMessages,1);
  assert.equal(out.text,'');
  assert.equal(out.truncated,false);
  w1.done(0,'9\\n');
  assert.equal(await host.drain(),null);
  assert.equal(out.text,'9\\n');
  assert.equal(w0.terminated,1);
  host.close();assert.equal(w1.terminated,1);
});

test('a fired but cancelled old-generation startup timer cannot fault a restarted actor',async()=>{
  let counter=0;
  const timers=new Map(),cleared=[];
  const {host}=setup({
    setTimer:callback=>{const id=++counter;timers.set(id,callback);return id;},
    clearTimer:id=>{cleared.push(id);}
  });
  const old=host.spawn(0),w0=Transport.all[0];
  const oldTimer=timers.get(1);w0.ready();
  const next=host.restart(old),w1=Transport.all[1];
  oldTimer();
  w1.ready();host.send(next,7n);w1.done(0);
  assert.equal(await host.drain(),null);
  assert.ok(cleared.includes(1));
  host.close();
});
