import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalActorJobRouter } from '../src/local-actor-job-router.js';

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
      if (!list.length) throw Error('E_ACTOR_GROUP_EMPTY: no live workers');
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
  for(const job_id of ['', '\\uD800', 'a'.repeat(4097)]) {
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
