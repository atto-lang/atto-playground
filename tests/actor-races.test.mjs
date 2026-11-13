// Deterministic mock-Worker races; actual compiler/guest and Chromium run in
// the full CI. These tests verify host isolation and delivery bookkeeping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createActorHost } from '../src/actor-host.js';

const wasm=new Uint8Array([0,97,115,109,1,0,0,0]);
function harness(WorkerImpl, names=['A']) {
  const out={text:'',truncated:false};
  const host=createActorHost({wasm,names,out,WorkerImpl,workerUrl:'mock-actor-worker'});
  return {host,out};
}
class ManualWorker {
  static instances=[];
  constructor(){
    this.posts=[];this.terminations=0;
    ManualWorker.instances.push(this);
  }
  postMessage(value){this.posts.push(structuredClone(value));}
  terminate(){this.terminations++;}
  emit(data){this.onmessage?.({data});}
  get epoch(){return this.posts[0].generation;}
}
test('invalid ACK immediately quarantines worker while healthy sibling drains',async()=>{
  ManualWorker.instances=[];
  const {host,out}=harness(ManualWorker,['Broken','Healthy']);
  const a=host.spawn(0),b=host.spawn(1);
  const [wa,wb]=ManualWorker.instances;
  host.send(a,5n);host.send(b,42n);
  const waiting=host.drain();
  let settled=false;waiting.then(()=>{settled=true;});
  wa.emit({kind:'ready',generation:wa.epoch});
  wb.emit({kind:'ready',generation:wb.epoch});
  wa.emit({kind:'done',generation:wa.epoch,sequence:99,stdout:'INJECTED\\n'});
  assert.equal(wa.terminations,1,'faulted actor must terminate before sibling finishes');
  assert.equal(wb.terminations,0,'healthy sibling must remain runnable');
  assert.equal(out.text,'','invalid ACK output cannot leak');
  await Promise.resolve();
  assert.equal(settled,false,'fault report waits for healthy sibling');
  wa.emit({kind:'done',generation:wa.epoch,sequence:0,stdout:'ZOMBIE\\n'});
  wb.emit({kind:'done',generation:wb.epoch,sequence:0,stdout:'42\\n'});
  assert.match(await waiting,/E_ACTOR_PROTOCOL: invalid completion in actor Broken#0/);
  assert.equal(out.text,'42\\n');
  host.close();host.close();
  assert.equal(wa.terminations,1,'close must not terminate a quarantined worker twice');
  assert.equal(wb.terminations,1,'healthy worker terminates on close');
});

test('failed initialization transfer rolls back actor admission without leaking worker',async()=>{
  class InitFailure extends ManualWorker {
    static attempts=0;
    postMessage(msg){
      if(msg.kind==='init' && InitFailure.attempts++===0)throw Error('simulated DataCloneError');
      super.postMessage(msg);
    }
  }
  ManualWorker.instances=[];InitFailure.attempts=0;
  const {host,out}=harness(InitFailure);
  assert.throws(()=>host.spawn(0),/E_ACTOR_START/);
  assert.equal(host.count,0,'failed actor cannot consume a reference/quota');
  assert.equal(ManualWorker.instances[0].terminations,1);
  const a=host.spawn(0),w=ManualWorker.instances[1];
  host.send(a,3n);
  w.emit({kind:'ready',generation:w.epoch});
  w.emit({kind:'done',generation:w.epoch,sequence:0,stdout:'3\\n'});
  assert.equal(await host.drain(),null);
  assert.equal(out.text,'3\\n');
  host.close();
  assert.equal(w.terminations,1);
});

test('mail postMessage failure atomically quarantines only that actor',async()=>{
  class MailFailure extends ManualWorker {
    postMessage(msg){
      if(msg.kind==='mail' && this===ManualWorker.instances[0])throw Error('simulated transport error');
      super.postMessage(msg);
    }
  }
  ManualWorker.instances=[];
  const {host,out}=harness(MailFailure,['A','B']);
  const a=host.spawn(0),b=host.spawn(1);
  const [wa,wb]=ManualWorker.instances;
  assert.throws(()=>host.send(a,8n),/E_ACTOR_TRANSPORT/);
  assert.equal(wa.terminations,1);
  assert.throws(()=>host.send(a,8n),/target actor has failed/);
  host.send(b,42n);
  const p=host.drain();
  wb.emit({kind:'ready',generation:wb.epoch});
  wb.emit({kind:'done',generation:wb.epoch,sequence:0,stdout:'42\\n'});
  assert.match(await p,/E_ACTOR_TRANSPORT: mailbox delivery failed in actor A#0/);
  assert.equal(out.text,'42\\n');
  host.close();
  assert.equal(wa.terminations,1);
  assert.equal(wb.terminations,1);
});

test('many cancellation/ACK orderings do not resurrect a closed epoch',async()=>{
  // Deterministic permutations: valid, stale and late deliveries around close.
  for(let iteration=0;iteration<96;iteration++){
    ManualWorker.instances=[];
    const {host,out}=harness(ManualWorker);
    const ref=host.spawn(0),worker=ManualWorker.instances[0];
    host.send(ref,BigInt(iteration));
    const pending=host.drain();
    worker.emit({kind:'ready',generation:worker.epoch-1});
    if(iteration%3===0){
      host.close();
      worker.emit({kind:'ready',generation:worker.epoch});
      worker.emit({kind:'done',generation:worker.epoch,sequence:0,stdout:'ZOMBIE'});
      assert.match(await pending,/E_ACTOR_CANCELLED/);
      assert.equal(out.text,'');
    }else{
      worker.emit({kind:'ready',generation:worker.epoch});
      worker.emit({kind:'done',generation:worker.epoch-1,sequence:0,stdout:'STALE'});
      worker.emit({kind:'done',generation:worker.epoch,sequence:0,stdout:'ok'});
      assert.equal(await pending,null);
      assert.equal(out.text,'ok');
      host.close();
      worker.emit({kind:'done',generation:worker.epoch,sequence:0,stdout:'ZOMBIE'});
      assert.equal(out.text,'ok');
    }
    host.close();
    assert.equal(worker.terminations,1);
  }
});
