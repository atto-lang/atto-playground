# Compiled Job<int> — tenant-local delivery and ACK (draft)

**Implementation boundary:** stacked on [atto-playground#75](https://github.com/atto-lang/atto-playground/pull/75)
and [#74](https://github.com/atto-lang/atto-playground/pull/74).
The accompanying compiler branch is based on
[atto-source.rs#398](https://github.com/atto-lang/atto-source.rs/pull/398).
All four prerequisite PRs are separate; no merge of unrelated code is implied.

This branch delivers the actual `job_id`, `correlation_id`,
`attempt` and `payload` into a compiled `receive(Job<int> job)`
handler in the tenant-local Wasm runtime, and observes the handler's
`job.ack()` intent.

## Invocation

```js
const key={namespace:'tenant-a',actor_type:0,application_key:'orders'};
host.registry.register(key); // explicit activation, not implicit dispatch
const admission=host.jobs.dispatch_job({
  job_id:'order:42',
  target:{kind:'actor',key},
  value:42n,
  attempt:0n,
  correlation_id:'trace:example'
});
if(admission.status==='admitted') {
  // Still only a mailbox admission; NOT completed.
}
const fault=await host.drain();
const receipt=host.jobs.inspect('tenant-a','order:42');
// 'completed' only if this Job<int> actor ACKed and returned cleanly.
```

## Security and lifecycle

Only trusted host-local `jobs.dispatch_job` may create opaque claims;
ordinary guest `actor_send(i32,i64)` to a Job<int> actor is rejected.
The `atto.job.abi` section is independent of legacy
`atto.actor.abi`; a valid one-byte-per-actor route table selects
`actor_receive_job` only for Job<int> handlers. A legacy handler still
uses `actor_receive`, unchanged.

The trusted scheduler copies exact UTF-8 identities into a private
per-actor **append-only 64 KiB metadata region**, after the first
64 KiB of guest memory, and passes bounded packed descriptors.
It never rewrites an earlier job's ID. If there is no room, the job
fails as indeterminate rather than being reassigned to another actor.
The metadata region is released with the entire actor Wasm instance.

The ACK import checks the active actor's exact FIFO sequence, attempt,
opaque claim, and single-ACK state. It is inaccessible as an
unauthenticated main/other-actor request. Receipt state is promoted to
`completed` **only after normal Wasm return and host checks**. A
handler returning without `job.ack()` stays
`observed_executed`; an ACK followed by a trap stays
`indeterminate`. Duplicates never reenqueue, and a duplicate ID
with different attempt/correlation/payload/target is a conflict.

## Non-guarantees

All job receipts are **volatile** and erased on host close/restart.
They do not establish persistence, side-effect transactions, distributed
deduplication, exactly-once execution, or authenticated interprocess
proxy-actor ACKs. No multi-backend parity is asserted. Guest
`Job<int>` is *not yet* shipped in the pinned website compiler; its
integration test demands a fresh exact-source compiled compiler via
`ATTO_JOB_COMPILER_WASM` and otherwise fails instead of silently skipping.

For safety, the first-64-KiB guest heap limit, 64-KiB immutable
metadata budget, per-actor mailbox bounds and i64 attempt limit
must be reviewed before accepting this profile into the stable spec.
