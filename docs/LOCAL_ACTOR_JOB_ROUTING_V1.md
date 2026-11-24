# Local actor job routing v1 — host-only

This host adapter assigns `job_id` to a **previously activated actor** or to
exactly **one eligible member of an ActorGroup**, reusing the existing physical
mailbox. It builds on `src/local-actor-registry.js` and
`src/local-actor-groups.js`. It is **not** a guest compiler intrinsic, a
persistent broker, or a cross-node ownership service.

## Trusted-host usage

```js
const orders = { namespace: 'tenant-1', actor_type: 0, application_key: 'orders' };
const workers = { namespace: 'tenant-1', actor_type: 0, group_name: 'workers' };

// Host activates and authorizes actors separately; routing never activates.
const a = host.registry.get_or_create(orders);
host.groups.join(workers, a);
const b = host.registry.get_or_create({ ...orders, application_key: 'worker-2' });
host.groups.join(workers, b);

// Exact existing actor, one local mailbox admission:
host.jobs.dispatch_job({
  job_id: 'order-101',
  target: { kind: 'actor', key: orders },
  value: 42n
});

// Pick just one live group member with deterministic rendezvous ranking:
host.jobs.dispatch_job({
  job_id: 'order-102',
  target: { kind: 'group', group: workers },
  value: 43n
});
```

Only trusted host code receives `host.jobs`. Do **not** expose host objects,
registration tokens, physical actor refs or slots to guest code.

## Invariants

- Identity is the exact `(namespace, job_id)` pair. The namespace comes from
  the typed actor/group target. The total UTF-8 budget is 4,096 bytes; strings
  must be valid UTF-16. Identifiers are codepoint-exact and case-sensitive.
- A successful `dispatch_job` returns `{status:'admitted',job_id,ref}`.
  The `ref` is an existing physical `ActorRef`, not a virtual ref, promise
  of execution, receipt from the actor, or durable ACK.
- Repeating the same job ID, target and i64 payload returns
  `{status:'duplicate',...}` and **does not send a second message**.
  Changing the target/payload with the same ID fails with
  `E_ACTOR_JOB_CONFLICT`.
- Missing actors return `E_ACTOR_JOB_ABSENT`. An empty group returns
  `E_ACTOR_GROUP_EMPTY`; **neither case activates a worker or consumes the
  job ID**. Register/join an actor explicitly and resubmit.
- A failed/throwing send produces `E_ACTOR_JOB_INDETERMINATE` and reserves
  the job ID. The downstream send may have committed before throwing. Never
  silently try a second actor. Reconcile with actor/broker state externally.
  A successful empty-group check is represented by `null` from
  `groups.dispatch_one`, **not** by parsing an exception message.
- Group ranking is rendezvous hashing over the exact job ID and host-only
  monotonically allocated physical slot. It is stable for a fixed membership
  set and avoids sending to all members. Membership changes can choose a
  different member for a *new* job; admitted IDs stay fenced in the receipt map.
  Membership does not grant lifecycle ownership or supervisor authority.
- Assignment and pub/sub are separate methods: `groups.dispatch_one`
  chooses one member; `groups.broadcast` remains non-atomic fan-out.
- No automatic receipt eviction: `max_jobs` (default 4,096, max 65,536)
  bounds memory and fails closed with `E_ACTOR_JOB_FULL` at capacity.
  A new router epoch (including after shutdown) does **not** retain dedup
  protection. Durable brokers need their own durable job-ID ledger.
- Host close invalidates all routes and clears transient receipts. An
  in-flight close must not claim a successful admission.

## Deliberate limitations and required follow-ups

The current guest `actor_send(i32,i64)` ABI carries **only an i64 payload**.
The job ID is a host-side routing/idempotency key; **it is not included in the
actor's mailbox message**. A worker that needs the job ID, attempt number,
reply address, or completion acknowledgement requires a typed envelope and a
compiled guest contract, plus authorization checks.

Single-flight admission is local to one synchronous JS event loop; it is not
atomic across OS processes, browser workers, host instances, or machines.
Repeated attempts across router restarts require durable deduplication,
generation fencing, actor completion receipts, and an explicit redelivery
policy. This implementation does not promise exactly-once processing.

Node tests cover duplicate IDs, conflicting targets, empty groups, stale
membership, one-worker selection, failed admissions, reentrant callbacks,
shutdown, and actual local registry/group integration. Run `npm test`
and the browser/tenant host suites on the **exact branch head**; zero-step
GitHub Actions runs do not count as executed tests.
