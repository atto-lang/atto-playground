# Local keyed actor registry v1 (host implementation)

This documents the host-side implementation in `src/local-actor-registry.js`
and its current limitations. It is **not** a compiled AttoLang guest interface
or a distributed Orleans-compatible actor directory.

## Identity and lifetime

- The logical key is `(namespace, actor_type, application_key)`, with an
  aggregate 4,096-byte UTF-8 budget. Keys are case-sensitive and codepoint
  exact; no implicit Unicode normalization is performed.
- `registry.ref_for(key)` creates a frozen *logical key reference only*.
  It does not activate an actor, create a broker queue, or authorize a send.
- `registry.lookup(key)` returns a physical reference or null, with a
  best-effort liveness check; successful mailbox admission is checked later.
- `registry.register(key)` and `registry.get_or_create(key)` explicitly
  allocate at most one local actor per key, using synchronous host callbacks.
  Async factories, cross-worker atomicity and distributed coordination
  are not part of this implementation.
- `registry.register(key)` returns `{ref, token, created}`; a token is
  produced only for the caller that creates the activation.
- `registry.unregister(key, token)` retires only the exact registration;
  stale cleanup cannot remove a newer incarnation.
- `registry.send(ref, payload)` accepts only opaque physical references
  produced by the same registry. It does not accept virtual references,
  cloned objects, numeric slots, or a physical ref from a prior incarnation.
- A monotonic global BigInt incarnation counter and private registry epoch
  prevent ABA without retaining an unbounded tombstone entry per key.
  Physical slots are **not reused** during the lifetime of a registry.
- Failed activation rolls back the provisional actor. Retirement also
  rechecks physical liveness: a callback that returns without stopping a live
  actor quarantines the registry. If retirement itself becomes uncertain, the
  registry closes to prevent a second keyed owner.
- Explicit retirement may **drop previously admitted but unprocessed mail**:
  admission is not delivery, durability, or exactly-once execution.

## AttoLang source syntax target

Future guest-facing typed ActorRefs should preserve one typed `receive()`
handler and `on` on every `match` arm:

```atto
define serial actor QueueActor as
    receive(msg: QueueMessage) {
        match msg over
            on QueueMessage.Publish(value) ->
                handle_publish(value),
            on QueueMessage.Consume(reply_to) ->
                handle_consume(reply_to),
            on QueueMessage.GetStats(reply_to) ->
                handle_stats(reply_to)
        end
    }
end
```

**Syntax target only:** this ADT example is not run by the current browser
compiler. The existing browser guest ABI still uses numeric actor references
and an i64 mailbox transport. Typed `ActorRef<T>`, automatic virtual
activation, persistent queues, authorization, leases/fencing, and cross-node
routing require separate compiler/runtime work and executed conformance proof.

## Verification

The local registry has adversarial host tests and integration with both
dedicated Worker and actual tenant-local WebAssembly guest instances.
The exact-tree alternate-org CI receipt must identify the tested source
commit and tree. Tests are not evidence for distributed behavior.
