# Host-observed actor job execution (stacked prototype)

**Status:** HOST_ONLY, VOLATILE, tenant-local Wasm runtime. This is a follow-up to
[local job routing v1](LOCAL_ACTOR_JOB_ROUTING_V1.md), not a new guest ABI,
a source-level `Job<T>` compiler implementation, a guest ACK, or proof that an
external side effect committed.

## Execution path

1. A trusted host obtains an already-live typed actor or ActorGroup and calls
   `host.jobs.dispatch_job({job_id, target, value})` as before.
2. The router creates an opaque, never-exported mailbox claim. The existing
   registry or single-member group dispatcher forwards it to the tenant
   host's `send()` alongside the original i64 payload. The trusted host
   binds the claim to the exact monotonic actor slot **before** enqueue.
3. `dispatch_job` returns **admitted** only after the mailbox send succeeds.
   No job ID is sent to the guest: the `atto.browser.guest.v2` import and
   `actor_receive(type, value, sequence)` exports are unchanged.
4. As the tenant-local scheduler actually calls the Wasm `actor_receive`,
   it records `observed_started`; only after normal handler return and
   memory/output checks does it record `observed_executed`.
5. A trap, unknown post-send outcome, or retirement with queued work marks
   the host receipt **indeterminate**, never automatically retargeting a
   successor. Healthy sibling actors can still complete their jobs.
6. `host.jobs.inspect(namespace, job_id)` exposes current volatile host
   observation. Duplicates of admitted/executed jobs still never re-enqueue;
   indeterminate jobs reject automatic retries.

## Security and consistency boundaries

The mailbox claim is object-identity-checked, scoped to one router instance,
validated against the actor's monotonic local slot, and never returned with a
dispatch receipt or exposed to the guest's import namespace. Forged, reused,
foreign or invalid claim transitions are rejected. Group dispatch and registry
admission never broadcast, infer completion from a successful send, or silently
retry a different actor.

`observed_executed` means the trusted scheduler saw **this compiled Wasm
handler return normally**, not that the handler issued a protocol ACK, that a
write was committed, or that a durable job ledger exists. A subsequent crash
can lose a volatile observation. Close invalidates every receipt, and after
process restart deduplication is lost. True `Job<T>` guest-visible IDs,
authenticated ACKs, attempts, cancellation, WAL/fencing and cross-backend
parity remain tracked by
[atto-platform-conformance#95](https://github.com/atto-lang/atto-platform-conformance/issues/95)
and the proposed [atto-spec#113](https://github.com/atto-lang/atto-spec/pull/113).

The code is stacked on the still-unmerged
[atto-playground#74](https://github.com/atto-lang/atto-playground/pull/74).
Its new tests use the pinned **AttoLang Rust/Wasm compiler** to compile actual
`.atto` actor handlers and execute real Wasm in the tenant host; host execution
observation is not interchangeable with guest-level implementation of Job<T>.
