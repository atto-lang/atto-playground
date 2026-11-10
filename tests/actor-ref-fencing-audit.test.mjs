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
  const ref=host.spawn(0),sibling=host.spawn(0),worker=Transport.all[0];
  worker.ready();Transport.all[1].ready();host.send(ref,1n);
  worker.emit({kind:'fault',message:'E_PANIC: guest trap',stdout:'prior output\\n',truncated:false});
  assert.equal(out.text,'prior output\\n');
  assert.throws(()=>host.send(ref,3n),/E_ACTOR_REF_STALE/);
  assert.throws(()=>host.send(sibling,3n),/E_ACTOR_FAILED/);
  assert.throws(()=>host.spawn(0),/E_ACTOR_FAILED/);
  assert.throws(()=>host.restart(ref),/E_ACTOR_REF_STALE/);
  assert.throws(()=>host.restart(sibling),/E_ACTOR_FAILED/);
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

test('retired Worker identity cannot be resurrected by a later restart',async()=>{
  const shared=new Transport();
  class ReusedWorker {constructor(){return shared;}}
  const {host}=setup({WorkerImpl:ReusedWorker});
  const ref=host.spawn(0);
  shared.ready();
  assert.equal(shared.sent.length,1);
  assert.throws(()=>host.restart(ref),/E_ACTOR_ISOLATION/,
    'a terminated Worker object must never be readmitted as a new generation');
  assert.equal(shared.sent.length,1,'no second init was delivered');
  assert.equal(shared.terminated,1,'retired object terminated exactly once');
  assert.match(await host.drain(),/E_ACTOR_RESTART/);
  host.close();
  assert.equal(shared.terminated,1);
});

test('throwing Worker callback setters and terminate cannot abort sibling fencing',async()=>{
  class FragileWorker extends Transport {
    get onmessage(){return this._onmessage;}
    set onmessage(value){
      if(value===null)throw new Error('cannot remove callback');
      this._onmessage=value;
    }
    terminate(){this.terminated++;throw new Error('terminate adapter failure');}
  }
  let instances=0;
  class Adapter {constructor(){return instances++===0?new FragileWorker():new Transport();}}
  const {host,out}=setup({WorkerImpl:Adapter});
  const a=host.spawn(0),b=host.spawn(0);
  const [w0,w1]=Transport.all;
  w0.ready();w1.ready();
  const lateMessage=w0.onmessage;
  host.send(a,1n);host.send(b,2n);
  assert.doesNotThrow(()=>w0.emit({kind:'done',sequence:99,stdout:'FAKE'}),
    'a failing cleanup adapter cannot interrupt terminal host shutdown');
  assert.equal(w0.terminated,1);
  assert.equal(w1.terminated,1,'sibling must be fenced despite first adapter throwing');
  assert.equal(out.text,'');
  assert.doesNotThrow(()=>lateMessage({data:{kind:'done',sequence:0,stdout:'LATE'}}));
  assert.equal(out.text,'','stale callback is fenced even if its setter rejected null');
  assert.match(await host.drain(),/E_ACTOR_PROTOCOL/);
  assert.doesNotThrow(()=>host.close());
  assert.deepEqual(Transport.all.map(w=>w.terminated),[1,1]);
});

test('throwing timer cancellation cannot leave a recoverable sibling running',async()=>{
  let id=0,restartCallback=null,restartId=null;
  const {host}=setup({
    supervision:{strategy:'one-for-one',initialBackoffMs:10,maxBackoffMs:10},
    setTimer:(fn,ms)=>{
      const token=++id;
      if(ms===10){restartCallback=fn;restartId=token;}
      return token;
    },
    clearTimer:()=>{throw new Error('clearTimer adapter failed');}
  });
  const a=host.spawn(0),b=host.spawn(0);
  const [w0,w1]=Transport.all;
  assert.doesNotThrow(()=>{w0.ready();w1.ready();},
    'startup cancellation is best effort and must not throw into event handlers');
  host.send(a,1n);
  w0.emit({kind:'fault',message:'E_PANIC: guest trap',stdout:'',truncated:false});
  assert.equal(host.stats.restartPending,1);
  assert.ok(restartId!==null);
  host.send(b,2n);
  assert.doesNotThrow(()=>w1.emit({kind:'done',sequence:99}),
    'a terminal failure must cancel all restart callbacks despite clearTimer throwing');
  assert.deepEqual([w0.terminated,w1.terminated],[1,1]);
  assert.equal(host.stats.restartPending,0);
  assert.match(await host.drain(),/E_ACTOR_PROTOCOL/);
  const count=Transport.all.length;
  restartCallback(); // stale callback can arrive after throwing cancellation
  assert.equal(Transport.all.length,count,'stale timer must not resurrect a Worker');
  assert.doesNotThrow(()=>host.close());
});

test('invalid or synchronously invoked restart timers fail closed without Worker admission',async t=>{
  for(const variant of ['null-token','synchronous']){
    await t.test(variant,async()=>{
      let id=0;
      const {host}=setup({
        supervision:{strategy:'one-for-one',initialBackoffMs:10,maxBackoffMs:10},
        setTimer:(fn,ms)=>{
          if(ms===10){
            if(variant==='synchronous'){fn();return ++id;}
            return null;
          }
          return ++id;
        },
        clearTimer:()=>{}
      });
      const ref=host.spawn(0),worker=Transport.all[0];
      worker.ready();host.send(ref,1n);
      assert.doesNotThrow(()=>worker.emit({kind:'fault',
        message:'E_PANIC: guest trap',stdout:'',truncated:false}));
      assert.match(await host.drain(),/E_SUPERVISOR_TIMER/);
      assert.equal(host.stats.restartPending,0);
      assert.equal(Transport.all.length,1,'invalid timer cannot admit a replacement');
      assert.equal(worker.terminated,1);
      host.close();
    });
  }
});
