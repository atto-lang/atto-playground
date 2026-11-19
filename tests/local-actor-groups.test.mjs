import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalActorGroups, createLocalPubSub } from '../src/local-actor-groups.js';

const group = (group_name='updates',namespace='tenant-a',actor_type=0) => ({namespace, actor_type, group_name});
function fixture({ max_groups, max_members_per_group, max_memberships }={}) {
  let nextSlot=0;
  const slots = new Map(), refs = new WeakMap(), deliveries = [];
  const registry = {
    make(namespace='tenant-a',actor_type=0) {
      const ref = Object.freeze({kind:'ActorRef',namespace,actor_type});
      refs.set(ref, nextSlot); slots.set(nextSlot++, true); return ref;
    },
    retire(ref) { slots.set(refs.get(ref),false); },
    slot_for(ref) {
      const slot=refs.get(ref);
      if (!Number.isInteger(slot) || !slots.get(slot)) throw Error('E_ACTOR_REF_STALE: invalid');
      return slot;
    },
    send(ref, payload) {
      const slot=this.slot_for(ref);
      if (payload===999n && slot===1) throw Error('E_MAILBOX_FULL: synthetic');
      deliveries.push([slot,payload]);
    }
  };
  const groups=createLocalActorGroups({registry,max_groups,max_members_per_group,max_memberships});
  const pubsub=createLocalPubSub(groups);
  return {registry,groups,pubsub,deliveries};
}

test('group keys are typed, namespaced and unambiguous including NUL and colons',()=>{
  const f=fixture(), a=f.registry.make(), b=f.registry.make();
  f.groups.join(group('a:b'),a);
  f.groups.join(group('b'),b);
  assert.deepEqual(f.groups.members(group('a:b')),[a]);
  assert.deepEqual(f.groups.members(group('b')),[b]);
  assert.deepEqual(f.groups.members(group('a\u0000b')) ,[]);
  assert.equal(f.groups.group_count,2);
});
test('foreign, cloned and stale refs cannot join or cross a namespace or type',()=>{
  const f=fixture(), ref=f.registry.make();
  assert.throws(()=>f.groups.join(group('q','tenant-b'),ref),/E_ACTOR_GROUP_SCOPE/);
  assert.throws(()=>f.groups.join(group('q','tenant-a',1),ref),/E_ACTOR_GROUP_SCOPE/);
  assert.throws(()=>f.groups.join(group('q'),{...ref}),/E_ACTOR_REF_STALE/);
  f.registry.retire(ref);
  assert.throws(()=>f.groups.join(group('q'),ref),/E_ACTOR_REF_STALE/);
  assert.equal(f.groups.membership_count,0);
});
test('join is idempotent and leave requires exact token; stale leaves cannot remove successor',()=>{
  const f=fixture(), k=group('jobs'), a=f.registry.make();
  const t=f.groups.join(k,a);
  assert.equal(f.groups.join(k,a),t);
  assert.equal(f.groups.membership_count,1);
  assert.equal(f.groups.leave(k,{}),false);
  assert.equal(f.groups.leave(k,t),true);
  assert.equal(f.groups.leave(k,t),false);
  const next=f.registry.make();
  f.groups.join(k,next);
  assert.equal(f.groups.leave(k,t),false);
  assert.deepEqual(f.groups.members(k),[next]);
});
test('limits reject atomically and group cleanup reclaims quota',()=>{
  const f=fixture({max_groups:1,max_members_per_group:1,max_memberships:1});
  const a=f.registry.make(), b=f.registry.make();
  const token=f.groups.join(group('first'),a);
  assert.throws(()=>f.groups.join(group('first'),b),/E_ACTOR_GROUP_FULL/);
  assert.throws(()=>f.groups.join(group('second'),b),/E_ACTOR_GROUP_FULL/);
  assert.equal(f.groups.group_count,1);
  assert.equal(f.groups.membership_count,1);
  f.groups.leave(group('first'),token);
  assert.equal(f.groups.group_count,0);
  assert.ok(f.groups.join(group('second'),b));
});
test('pubsub sends once per subscriber and preserves partial-admission report',()=>{
  const f=fixture(), a=f.registry.make(), b=f.registry.make();
  const k=group('updates');
  f.pubsub.subscribe(k,a);f.pubsub.subscribe(k,b);
  assert.deepEqual(f.pubsub.publish(k,5n),{attempted:2,admitted:2,failed:0,stale:0});
  assert.deepEqual(f.pubsub.publish(k,999n),{attempted:2,admitted:1,failed:1,stale:0});
  assert.deepEqual(f.deliveries,[[0,5n],[1,5n],[0,999n]]);
});
test('dead actor pruned lazily and notification never evicts its reincarnation',()=>{
  const f=fixture(), k=group(), a=f.registry.make();
  f.pubsub.subscribe(k,a);
  f.registry.retire(a);
  assert.deepEqual(f.pubsub.publish(k,1n),{attempted:0,admitted:0,failed:0,stale:0});
  const replacement=f.registry.make();
  f.groups.join(k,replacement);
  assert.equal(f.groups.actor_stopped(a),0);
  assert.deepEqual(f.groups.members(k),[replacement]);
  assert.equal(f.groups.actor_stopped(replacement),1);
  assert.equal(f.groups.membership_count,0);
});
test('empty group does not activate actors or retain subscriptions',()=>{
  const f=fixture();
  assert.deepEqual(f.pubsub.publish(group('absent'),15n),{attempted:0,admitted:0,failed:0,stale:0});
  assert.equal(f.groups.group_count,0);
});
test('invalid UTF-16, invalid limits, oversize keys and malformed payloads fail closed',()=>{
  const f=fixture(),a=f.registry.make();
  assert.throws(()=>createLocalActorGroups({registry:f.registry,max_memberships:0}),/E_ACTOR_GROUP_LIMIT/);
  for(const k of [group(''),group('\uD800'),group('a'.repeat(4097))])
    assert.throws(()=>f.groups.join(k,a),/E_ACTOR_GROUP_KEY/);
  f.pubsub.subscribe(group(),a);
  for(const bad of [42, 1.1, 2n**63n, -(2n**63n)-1n])
    assert.throws(()=>f.pubsub.publish(group(),bad),/E_PUBSUB_PAYLOAD/);
  assert.deepEqual(f.deliveries,[]);
});
test('close invalidates groups and subscriptions with no residual resource charges',()=>{
  const f=fixture(),a=f.registry.make();
  f.pubsub.subscribe(group(),a);
  f.groups.close();f.groups.close();
  assert.equal(f.groups.membership_count,0);
  assert.equal(f.groups.group_count,0);
  assert.throws(()=>f.pubsub.publish(group(),1n),/E_ACTOR_GROUP_CLOSED/);
  assert.throws(()=>f.pubsub.subscribe(group(),a),/E_ACTOR_GROUP_CLOSED/);
});
test('registry liveness unexpected error is not misreported as actor exit',()=>{
  const registry={slot_for(){throw Error('host I/O fault')},send(){}};
  const g=createLocalActorGroups({registry});
  const a=Object.freeze({kind:'ActorRef',namespace:'tenant-a',actor_type:0});
  assert.throws(()=>g.join(group(),a),/host I\/O fault/);
  assert.equal(g.membership_count,0);
});

test('single-job group assignment admits exactly one deterministic member, not broadcast', () => {
  const f=fixture(), k=group('work'), a=f.registry.make(), b=f.registry.make(), c=f.registry.make();
  f.groups.join(k,a); f.groups.join(k,b); f.groups.join(k,c);
  const chosen=f.groups.dispatch_one(k,'job-1',10n).ref;
  assert.ok([a,b,c].includes(chosen));
  for(let i=0;i<8;i++) assert.equal(f.groups.dispatch_one(k,'job-1',11n).ref,chosen);
  assert.equal(f.deliveries.length,9);
  // Rejoining the same ref changes no membership, and selection is order-independent.
  assert.equal(f.groups.dispatch_one(k,'job-1',12n).ref,chosen);
  assert.equal(f.deliveries.length,10);
});

test('job selection changes only when membership changes and never activates a worker', () => {
  const f=fixture(), k=group('work');
  assert.equal(f.groups.dispatch_one(k,'id',1n),null);
  assert.equal(f.groups.group_count,0);
  const a=f.registry.make(), b=f.registry.make();
  const ta=f.groups.join(k,a);
  f.groups.join(k,b);
  f.registry.retire(a);
  assert.equal(f.groups.dispatch_one(k,'id',2n).ref,b);
  assert.deepEqual(f.groups.members(k),[b]);
  assert.equal(f.groups.leave(k,ta),false);
  f.registry.retire(b);
  assert.equal(f.groups.dispatch_one(k,'id',2n),null);
});

test('group job admission is single-attempt and protects group mutation from reentrant send', () => {
  const f=fixture(), k=group('work'), a=f.registry.make(), b=f.registry.make();
  f.groups.join(k,a); f.groups.join(k,b);
  let attempts=0;
  f.registry.send=(ref,value)=>{
    attempts++;
    assert.throws(()=>f.groups.leave(k,{}),/E_ACTOR_GROUP_REENTRANT/);
    throw Error('injected failure after admission');
  };
  assert.throws(()=>f.groups.dispatch_one(k,'id',5n),/injected failure/);
  assert.equal(attempts,1,'never retry on another member after ambiguous send');
});

test('group job IDs and payloads are checked before any mailbox admission', () => {
  const f=fixture(), k=group(), a=f.registry.make();
  f.groups.join(k,a);
  for(const id of ['', '\uD800', 'a'.repeat(4097)]) {
    assert.throws(()=>f.groups.dispatch_one(k,id,1n),/E_ACTOR_GROUP_KEY/);
  }
  for(const payload of [0, 2n**63n, -(2n**63n)-1n]) {
    assert.throws(()=>f.groups.dispatch_one(k,'job',payload),/E_ACTOR_GROUP_PAYLOAD/);
  }
  assert.deepEqual(f.deliveries,[]);
});
