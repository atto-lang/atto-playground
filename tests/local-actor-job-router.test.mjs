import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalActorJobRouter } from '../src/local-actor-job-router.js';
import { createLocalActorRegistry } from '../src/local-actor-registry.js';
import { createLocalActorGroups } from '../src/local-actor-groups.js';

const akey = (application_key = 'orders', namespace = 'tenant-a') =>
  ({ namespace, actor_type: 0, application_key });
const gkey = (group_name = 'workers', namespace = 'tenant-a') =>
  ({ namespace, actor_type: 0, group_name });
const actor = (key = akey()) => ({ kind: 'actor', key });
const group = (key = gkey()) => ({ kind: 'group', group: key });

function fixture(max_jobs = 16) {
  const refs = new Map(), deliveries = [], members = new Map();
  let lookups = 0;
  let sending = null;
  const registry = {
    lookup(k) {
      lookups++;
      return refs.get(JSON.stringify([k.namespace, k.actor_type, k.application_key])) ?? null;
    },
    send(ref, value) {
      if (sending) sending(ref, value);
      deliveries.push([ref, value]);
    }
  };
  const groups = {
    dispatch_one(key, job_id, value) {
      const list = members.get(JSON.stringify([key.namespace, key.actor_type, key.group_name])) ?? [];
      if (!list.length) return null; // Proven no-send result, not an exception.
      // Real deterministic-hashing tests are in local-actor-groups.test.mjs.
      const ref = list[0];
      registry.send(ref, value);
      return Object.freeze({ ref });
    }
  };
  const router = createLocalActorJobRouter({ registry, groups, max_jobs });
  return {
    router, deliveries,
    attach(k = akey()) {
      const ref = Object.freeze({ id: Symbol() });
      refs.set(JSON.stringify([k.namespace, k.actor_type, k.application_key]), ref);
      return ref;
    },
    join(ref, key = gkey()) {
      const k = JSON.stringify([key.namespace, key.actor_type, key.group_name]);
      members.set(k, [...(members.get(k) ?? []), ref]);
    },
    set_send(fn) { sending = fn; },
    get lookups() { return lookups; }
  };
}

test('existing actor is reused; duplicate job ID never re-enqueues', () => {
  const f = fixture(), ref = f.attach();
  const request = { job_id: 'j:1', target: actor(), value: 77n };
  assert.deepEqual(f.router.dispatch_job(request), { status: 'admitted', job_id: 'j:1', ref });
  assert.deepEqual(f.router.dispatch_job(request), { status: 'duplicate', job_id: 'j:1', ref });
  assert.deepEqual(f.deliveries, [[ref, 77n]]);
  assert.equal(f.router.size, 1);
});

test('same job ID is isolated by tenant namespace; conflicting target or payload rejected', () => {
  const f = fixture(), a = f.attach(akey()), b = f.attach(akey('orders', 'tenant-b'));
  f.router.dispatch_job({job_id:'job',target:actor(),value:1n});
  f.router.dispatch_job({job_id:'job',target:actor(akey('orders','tenant-b')),value:1n});
  assert.deepEqual(f.deliveries, [[a,1n],[b,1n]]);
  assert.throws(() => f.router.dispatch_job({job_id:'job',target:actor(),value:2n}), /E_ACTOR_JOB_CONFLICT/);
  assert.throws(() => f.router.dispatch_job({job_id:'job',target:group(),value:1n}), /E_ACTOR_JOB_CONFLICT/);
});

test('absent actor is never spawned; explicit later registration can admit the ID', () => {
  const f = fixture(), request = {job_id:'id',target:actor(),value:3n};
  assert.throws(() => f.router.dispatch_job(request), /E_ACTOR_JOB_ABSENT/);
  assert.equal(f.router.size,0);
  const ref=f.attach();
  assert.equal(f.router.dispatch_job(request).ref,ref);
  assert.equal(f.lookups,2);
});

test('group selects one existing worker, not fan-out; empty group is retryable', () => {
  const f=fixture(), request={job_id:'job',target:group(),value:9n};
  assert.throws(() => f.router.dispatch_job(request), /E_ACTOR_GROUP_EMPTY/);
  assert.equal(f.router.size,0);
  const a=f.attach();f.join(a);f.join(Object.freeze({id:2}));
  assert.equal(f.router.dispatch_job(request).ref,a);
  assert.equal(f.router.dispatch_job(request).status,'duplicate');
  assert.deepEqual(f.deliveries,[[a,9n]]);
});

test('post-admission error reserves indeterminate ID and forbids an automatic retry', () => {
  const f=fixture(), ref=f.attach();
  f.set_send((r,v)=>{f.deliveries.push([r,v]);throw Error('transport lost ACK');});
  const request={job_id:'j',target:actor(),value:10n};
  assert.throws(() => f.router.dispatch_job(request), /E_ACTOR_JOB_INDETERMINATE/);
  assert.deepEqual(f.router.inspect('tenant-a','j'),{status:'indeterminate',ref:null});
  assert.throws(() => f.router.dispatch_job(request), /E_ACTOR_JOB_INDETERMINATE/);
  assert.deepEqual(f.deliveries,[[ref,10n]]);
});

test('reentrant send callback cannot double-dispatch same job', () => {
  const f=fixture();f.attach();
  const request={job_id:'j',target:actor(),value:10n};
  f.set_send(()=>{assert.throws(()=>f.router.dispatch_job(request),/E_ACTOR_JOB_REENTRANT/);});
  assert.equal(f.router.dispatch_job(request).status,'admitted');
  assert.equal(f.deliveries.length,1);
});

test('shutdown during send invalidates the reservation and never reports success', () => {
  const f=fixture();f.attach();
  f.set_send(()=>f.router.close());
  assert.throws(() => f.router.dispatch_job({job_id:'j',target:actor(),value:1n}), /E_ACTOR_JOB_INDETERMINATE/);
  assert.throws(() => f.router.inspect('tenant-a','j'),/E_ACTOR_JOB_CLOSED/);
});

test('invalid payload, key, capacity, and conflicting receipts are fail-atomic',()=>{
  const f=fixture(1);f.attach();
  for(const job_id of ['', '\uD800', 'a'.repeat(4097)]) {
    assert.throws(()=>f.router.dispatch_job({job_id,target:actor(),value:1n}), /E_ACTOR_JOB_KEY/);
  }
  for(const value of [1,1.2,(1n<<63n),-(1n<<63n)-1n]) {
    assert.throws(()=>f.router.dispatch_job({job_id:'j',target:actor(),value}),/E_ACTOR_JOB_PAYLOAD/);
  }
  assert.equal(f.router.size,0);
  f.router.dispatch_job({job_id:'j',target:actor(),value:1n});
  assert.throws(()=>f.router.dispatch_job({job_id:'another',target:actor(),value:1n}),/E_ACTOR_JOB_FULL/);
  assert.equal(f.deliveries.length,1);
  assert.throws(()=>createLocalActorJobRouter({registry:{},groups:{}}),/E_ACTOR_JOB/);
  assert.throws(()=>createLocalActorJobRouter({registry:{lookup(){},send(){}},groups:{dispatch_one(){}},max_jobs:0}),/E_ACTOR_JOB_LIMIT/);
});

test('close clears bounded receipts and prevents further dispatch',()=>{
  const f=fixture();f.attach();
  f.router.dispatch_job({job_id:'j',target:actor(),value:4n});
  f.router.close();f.router.close();
  assert.equal(f.router.size,0);
  assert.throws(()=>f.router.dispatch_job({job_id:'j',target:actor(),value:4n}),/E_ACTOR_JOB_CLOSED/);
});

test('forged empty-group error after a send cannot enable job replay', () => {
  const f=fixture(), ref=f.attach(); f.join(ref);
  f.set_send((r,v)=>{f.deliveries.push([r,v]);throw Error('E_ACTOR_GROUP_EMPTY: forged after admission');});
  const request={job_id:'same',target:group(),value:5n};
  assert.throws(()=>f.router.dispatch_job(request),/E_ACTOR_JOB_INDETERMINATE/);
  assert.equal(f.router.inspect('tenant-a','same').status,'indeterminate');
  assert.throws(()=>f.router.dispatch_job(request),/E_ACTOR_JOB_INDETERMINATE/);
  assert.deepEqual(f.deliveries,[[ref,5n]]);
});

test('actual registry + ActorGroup host modules route to existing live mailboxes', () => {
  let next=0;
  const slots=new Map(), deliveries=[];
  const registry=createLocalActorRegistry({
    names:['Worker'],
    spawn() {const slot=next++;slots.set(slot,true);return slot;},
    isLive(slot) {return slots.get(slot)===true;},
    retire(slot) {slots.set(slot,false);return true;},
    send(slot,value) {
      if(!slots.get(slot)) throw Error('E_ACTOR_REF_STALE: actor stopped');
      deliveries.push([slot,value]);
    }
  });
  const groups=createLocalActorGroups({registry});
  const jobs=createLocalActorJobRouter({registry,groups});
  const k1={namespace:'tenant-a',actor_type:0,application_key:'one'};
  const k2={namespace:'tenant-a',actor_type:0,application_key:'two'};
  const first=registry.register(k1).ref, second=registry.register(k2).ref;
  const membership={namespace:'tenant-a',actor_type:0,group_name:'work'};
  groups.join(membership,first);groups.join(membership,second);
  const routed=jobs.dispatch_job({job_id:'id-1',target:{kind:'actor',key:k1},value:7n});
  assert.equal(routed.ref,first);
  const chosen=jobs.dispatch_job({job_id:'id-2',target:{kind:'group',group:membership},value:8n}).ref;
  assert.ok([first,second].includes(chosen));
  assert.equal(jobs.dispatch_job({job_id:'id-2',target:{kind:'group',group:membership},value:8n}).status,'duplicate');
  assert.equal(deliveries.length,2);
  // The next job can use the remaining member after a physical actor stops.
  const dead=registry.slot_for(chosen);
  slots.set(dead,false);
  const survivor=chosen===first?second:first;
  assert.equal(jobs.dispatch_job({job_id:'id-3',target:{kind:'group',group:membership},value:9n}).ref,survivor);
  assert.equal(deliveries.length,3);
  jobs.close();groups.close();registry.close();
});


test('1,024 distinct local jobs fill quota exactly; duplicates do not consume more slots', () => {
  const f=fixture(1024), ref=f.attach();
  for (let i=0;i<1024;i++) {
    assert.equal(f.router.dispatch_job({job_id:'bulk-'+i,target:actor(),value:BigInt(i)}).ref,ref);
  }
  assert.equal(f.router.size,1024);
  assert.equal(f.deliveries.length,1024);
  const before=f.lookups;
  for (let i=0;i<1024;i++) {
    assert.equal(f.router.dispatch_job({job_id:'bulk-'+i,target:actor(),value:BigInt(i)}).status,'duplicate');
  }
  assert.equal(f.lookups,before,'duplicate suppression must occur before physical actor lookup');
  assert.equal(f.deliveries.length,1024);
  assert.throws(()=>f.router.dispatch_job({job_id:'overflow',target:actor(),value:0n}),/E_ACTOR_JOB_FULL/);
  assert.equal(f.router.size,1024);
});

test('previously admitted ID never retargets a replacement actor or group', () => {
  const f=fixture(), first=f.attach();
  const job={job_id:'stable',target:actor(),value:14n};
  f.router.dispatch_job(job);
  const next=f.attach();
  assert.notEqual(first,next);
  assert.deepEqual(f.router.dispatch_job(job),{status:'duplicate',job_id:'stable',ref:first});
  assert.deepEqual(f.deliveries,[[first,14n]]);
  assert.throws(()=>f.router.dispatch_job({job_id:'stable',target:group(),value:14n}),/E_ACTOR_JOB_CONFLICT/);
});

test('signed i64 endpoints and zero are accepted without truncation', () => {
  const f=fixture(), ref=f.attach();
  const values=[-(1n<<63n),-1n,0n,1n,(1n<<63n)-1n];
  for(const [i,value] of values.entries())
    assert.equal(f.router.dispatch_job({job_id:'i64-'+i,target:actor(),value}).status,'admitted');
  assert.deepEqual(f.deliveries,values.map(v=>[ref,v]));
});

test('Unicode, NUL and separators cannot alias tenant/job identity', () => {
  const f=fixture(), ref=f.attach();
  const ids=['a:b','a\u0000b','a','e\u0301','é','🚀','🧑‍💻'];
  for(const id of ids)
    assert.equal(f.router.dispatch_job({job_id:id,target:actor(),value:0n}).status,'admitted');
  assert.equal(f.router.size,ids.length);
  for(const id of ids)
    assert.equal(f.router.inspect('tenant-a',id).status,'admitted');
  assert.deepEqual(f.deliveries,ids.map(()=>[ref,0n]));
  assert.equal(f.router.inspect('tenant-a','missing'),null);
});

test('UTF-8 key budget counts bytes, not JavaScript UTF-16 code units', () => {
  const f=fixture(), ref=f.attach();
  const fits='🚀'.repeat(1021); // 4084 bytes + namespace <= 4096
  const tooLong='🚀'.repeat(1024);
  assert.equal(f.router.dispatch_job({job_id:fits,target:actor(),value:1n}).ref,ref);
  assert.throws(()=>f.router.dispatch_job({job_id:tooLong,target:actor(),value:2n}),/E_ACTOR_JOB_KEY/);
  assert.equal(f.deliveries.length,1);
});

test('invalid actor types, target shapes and surrogate keys fail before any lookup', () => {
  const f=fixture();f.attach();
  for(const actor_type of [-1,1.5,Infinity,NaN,2**53,1n,'0',null]) {
    assert.throws(()=>f.router.dispatch_job({job_id:'j',target:actor({...akey(),actor_type}),value:1n}),
      /E_ACTOR_JOB_TARGET/);
  }
  for(const target of [null,{}, {kind:'broadcast',key:akey()}, {kind:'actor'}, {kind:'group',group:{...gkey(),group_name:''}},
    actor({...akey(),namespace:'\uD800'}),actor({...akey(),application_key:'x'.repeat(4097)})]) {
    assert.throws(()=>f.router.dispatch_job({job_id:'j',target,value:1n}),/E_ACTOR_JOB_(TARGET|KEY)/);
  }
  assert.equal(f.lookups,0);
  assert.equal(f.router.size,0);
  assert.deepEqual(f.deliveries,[]);
});

test('malicious target getter closing router cannot produce admission', () => {
  const f=fixture();f.attach();
  const source=akey();
  const target={kind:'actor',key:{
    get namespace() {f.router.close();return source.namespace;},
    actor_type:source.actor_type,application_key:source.application_key
  }};
  assert.throws(()=>f.router.dispatch_job({job_id:'j',target,value:1n}),/E_ACTOR_JOB_CLOSED/);
  assert.deepEqual(f.deliveries,[]);
  assert.equal(f.router.size,0);
});

test('registry closure during lookup cannot cause false admission or quota reservation', () => {
  let closedCalls=0;
  let jobs;
  const registry={
    lookup() {closedCalls++;jobs.close();return Object.freeze({slot:1});},
    send() {assert.fail('send after router close must be impossible');}
  };
  jobs=createLocalActorJobRouter({registry,groups:{dispatch_one(){assert.fail('not a group');}}});
  assert.throws(()=>jobs.dispatch_job({job_id:'j',target:actor(),value:1n}),/E_ACTOR_JOB_CLOSED/);
  assert.equal(closedCalls,1);
  assert.equal(jobs.size,0);
});

test('nested distinct IDs cannot bypass the reentrant dispatch guard', () => {
  const f=fixture();f.attach();
  f.set_send(()=>assert.throws(
    ()=>f.router.dispatch_job({job_id:'nested',target:actor(),value:11n}),
    /E_ACTOR_JOB_REENTRANT/));
  f.router.dispatch_job({job_id:'outer',target:actor(),value:10n});
  assert.equal(f.router.inspect('tenant-a','nested'),null);
  assert.equal(f.router.size,1);
  assert.equal(f.deliveries.length,1);
});

test('an indeterminate admission occupies capacity and cannot be evicted by a new ID', () => {
  const f=fixture(1), ref=f.attach();
  let sends=0;
  f.set_send(()=>{sends++;throw Error('ACK vanished');});
  const job={job_id:'unknown',target:actor(),value:1n};
  assert.throws(()=>f.router.dispatch_job(job),/E_ACTOR_JOB_INDETERMINATE/);
  assert.equal(f.router.size,1);
  assert.throws(()=>f.router.dispatch_job(job),/E_ACTOR_JOB_INDETERMINATE/);
  assert.throws(()=>f.router.dispatch_job({job_id:'other',target:actor(),value:1n}),/E_ACTOR_JOB_FULL/);
  assert.equal(sends,1);
  assert.equal(f.router.inspect('tenant-a','unknown').ref,null);
  assert.deepEqual(f.deliveries,[]);
  assert.ok(ref);
});

test('unexpected malformed group receipt after admission remains indeterminate', () => {
  const ref=Object.freeze({kind:'ActorRef'}), deliveries=[];
  const jobs=createLocalActorJobRouter({
    registry:{lookup(){return ref;},send(){}},
    groups:{dispatch_one(key,id,value){deliveries.push([key,id,value]);return {ref:null};}}
  });
  const job={job_id:'unknown-group-receipt',target:group(),value:42n};
  assert.throws(()=>jobs.dispatch_job(job),/E_ACTOR_JOB_INDETERMINATE/);
  assert.throws(()=>jobs.dispatch_job(job),/E_ACTOR_JOB_INDETERMINATE/);
  assert.equal(deliveries.length,1);
  assert.equal(jobs.inspect('tenant-a',job.job_id).status,'indeterminate');
});

test('known empty group and absent actor do not exhaust the finite receipt ledger', () => {
  const f=fixture(1);
  for(let i=0;i<50;i++) {
    assert.throws(()=>f.router.dispatch_job({job_id:'missing-'+i,target:actor(),value:1n}),/E_ACTOR_JOB_ABSENT/);
    assert.throws(()=>f.router.dispatch_job({job_id:'empty-'+i,target:group(),value:1n}),/E_ACTOR_GROUP_EMPTY/);
  }
  assert.equal(f.router.size,0);
  assert.equal(f.deliveries.length,0);
  f.attach();
  assert.equal(f.router.dispatch_job({job_id:'later',target:actor(),value:1n}).status,'admitted');
});
