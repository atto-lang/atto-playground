# Experimental browser actor supervisor epoch restart

## Scope and invariants

The private playground's `createActorHost(...)` has an explicitly supervisor-only
`restart(ref)` method. A numeric `ActorRef` remains the same within **one**
browser run, while every incarnation acquires a monotonically increasing
**run-local generation**. Each restart terminates the prior Web Worker and
creates a new Worker and fresh Wasm instance, globals, JSPI task scope,
continuation state, and mailbox sequence numbers.

- The parent fences callbacks by **both Worker object identity and generation
  captured at listener registration**, not merely a generation value supplied
  in an untrusted completion packet. Late `message`, `error`,
  `messageerror`, and forged new-generation payloads from earlier Worker
  callbacks cannot acknowledge mail or poison output/state.
- Any failed actor is immediately quarantined and its own Worker terminated;
  already-submitted sibling mail still runs in separate Workers. A deliberate
  explicit restart clears that actor's prior failure, **not** a sibling failure.
- `restart(ref)` is allowed only before `drain()` seals the mailbox.
  `drain()` and `close()` are idempotent and reject new work. Invalid refs
  and exhausted safe-integer generations fail closed.
- **At-most-once volatile policy:** old unacknowledged mail is discarded during
  restart. No automatic replay or hidden retry occurs. Mail for the new
  generation starts at sequence 0. Already-validated prior stdout is retained,
  but no old Worker output after restart may be appended.
- A replacement Worker that fails to start is terminated immediately; the
  actor remains failed, and the host reports an `E_ACTOR_RESTART` fault.
- A `suspends receive` retains mailbox exclusivity across each JSPI
  suspension. Restart terminates its Worker, so the new incarnation cannot
  execute the old continuation. This is browser-specific, **not** portable
  per-actor stack/arena suspension.

## Verification

The regression suite in `tests/actor-restart.test.mjs` executes **1,000
restarts of the same ActorRef** while an independent sibling processes 1,000
messages. It injects late old-Worker callbacks (including packets forging the
**new** generation), old error/decode callbacks, and verifies no stale output,
no duplicate completion, strict sibling FIFO and exactly-once Worker cleanup.
Additional cases cover restart after failure, a different actor's failure
remaining visible, drain/closed boundaries, failed Worker admission, and
immediate termination of a failed actor without killing siblings.

The reproducible seed suite `tests/actor-stress.test.mjs` continues to
exercise 8 seeds × 16 actors × 128 messages (16,384 deliveries), exact quotas,
and fresh-run cancellation. The negative mutation harness deliberately removes
generation, sequence, readiness, and now Worker-callback defenses in throwaway
temporary modules and requires their invariant probes to fail.

The real Chromium E2E suite additionally instantiates actual generated guest
Wasm/JSPI inside **real** actor Workers, restarts a suspending actor eight
times, and checks that only the final incarnation and healthy sibling emit
stdout. It runs against both the development app and packaged site.

## Not yet implemented

**This is NOT durable supervisor recovery.** The actor reference and epoch
exist only in memory for a single playground execution. A fresh browser run
starts a new namespace, has no persisted generation or durable mailbox, and
does not resume pending operations. The browser-only Worker model does not
prove cross-process fencing, durable message delivery, native carrier/thread
scheduling, actor-owned bounded stack/frame arenas, or stack-overflow isolation
in Java, LLVM, .NET or Forge. Persistent actor IDs/epochs must eventually come
from the trusted signed supervisor, with WAL/checkpoint and replay semantics,
and require their own security and conformance tests.

The compiler artifact remains pinned to the exact source/tree and SHA-256
already verified by the parent actor PR. No public Pages deployment or
compiler disclosure is authorized by this experimental change.
