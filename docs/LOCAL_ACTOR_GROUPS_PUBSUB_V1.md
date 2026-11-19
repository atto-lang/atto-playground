# Local actor groups and ephemeral pub/sub v1 (host-only)

This adds `src/local-actor-groups.js` to the existing synchronous,
generation-fenced registry proposal. It is **not full OTP**, not distributed,
not a durable broker, and not a compiled AttoLang library or guest ABI.
The two browser hosts expose `host.groups` and `host.pubsub` only to
trusted host code. Guest code cannot access those JavaScript objects.

## Typed and bounded group membership

- A group is identified by the exact triple `(namespace, actor_type, group_name)`.
  No string concatenation, Unicode normalization, group activation, or tenant
  namespace inference is allowed.
- `join(group, actor_ref)` requires an exact host-minted *physical* actor
  capability, a matching namespace and matching actor type, plus live
  registry generation. The returned opaque token is the only authority
  for `leave(group, token)`. A stale token never evicts a successor.
- Default quotas: 128 groups, 256 members per group and 4096 total
  memberships. Invalid input and quota refusal commit no subscription.
- `members(group)` returns a frozen snapshot and prunes retired physical
  references. `actor_stopped(ref)` is available for a trusted host to
  eagerly remove an exact incarnation. **Automatic crash/STOP notification
  is not yet wired**; lazy pruning prevents stale sends but does not provide
  OTP `pg`-equivalent immediate cleanup.
- `close()` invalidates all memberships and groups. A callback reentering
  another group mutation is rejected rather than corrupting counters.

## Ephemeral fan-out semantics

`pubsub.subscribe(topic, ref)`, `pubsub.unsubscribe(topic, token)`, and
`pubsub.publish(topic, i64_value)` use the same group membership store.
The current browser guest transport accepts only signed i64 BigInt data.
Publishes never start actors, register queues, infer authorization, or
keep durable/replayable history.

`publish` returns `{ attempted, admitted, failed, stale }`.
Each destination mailbox admission is independent. Partial fan-out is
possible; `admitted` does not prove execution, an ACK, or persistence.
Full mailboxes are reported as failed admissions, not silently retried.
Dead subscriptions are evicted on access. An empty topic yields all zeros.
Unexpected host errors from liveness checks remain errors rather than
being hidden as actor death.

## OTP-oriented remaining requirements

1. Introduce host-owned lifecycle monitors and an authenticated actor-exit
   notification path; execute removal *on* death, not only on lookup.
2. Add a supervision tree: child specifications, restart policies
   (`permanent`, `transient`, `temporary`), strategies
   (`one_for_one`, `one_for_all`, `rest_for_one`), restart intensity
   windows, escalation and ordered startup/shutdown. PANIC/STOP remain on
   the separate reserved priority CONTROL lane.
3. Implement typed `call`/`cast`, monitor/demonitor and bounded reply
   correlation with caller death, timeout and late-reply fencing.
4. Add tenant-authorized join/publish/subscribe capabilities; a namespace
   string alone is **not authorization**. Compile source-level
   `ActorGroup<T>` and `PubSub<T>` through checked HIR/MIR and actual
   guest targets instead of trusting JavaScript host calls.
5. Define delivery profiles (best effort vs acknowledged/durable) and
   load-shedding/backpressure, network partitions, fenced distributed
   membership, and conformance receipts from exact compiler/runtime SHAs.

See the existing merged actor registry specification
`atto-spec/language/actor-registry-v1.md` and the independent host-only
conformance proposal `atto-platform-conformance#70`.
