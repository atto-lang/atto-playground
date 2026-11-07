# Browser Wasm actor substrate v0 — experimental

**Status: executed host/worker prototype, NOT AttoLang `define actor` compilation.**
Source branch tests provide a target execution contract for future typed HIR/MIR
actor lowering. It does **not** parse or execute `spawn Worker()` from .atto
source and cannot claim five-backend conformance.

## Contract: atto.browser.actor.scalar.v0

- Each `spawnWasmActor(wasm)` creates one real **module Web Worker** with its
  **own Wasm instance**, including private mutable globals.
- Guest module must be valid Wasm of at most 1 MiB, **zero imports**, exactly
  one function export named `receive` with behavior `(i64)->i64`.
- V0 forbids table, memory, element, data, data-count, tag and start sections.
  Future actor heaps will require a new ABI version with explicit bounded memory.
- A browser message must be a signed i64 BigInt, structured-cloned, assigned a
  monotonic sequence id, and processed synchronously by the worker.
- Host admission is limited to 32 outstanding messages (configurable lower).
  Every message has a deadline (default 3 seconds). Any trap, timeout,
  unexpected response, malformed packet or worker failure **terminates that
  actor** and rejects its pending messages. No actor auto-resurrection.
- `close()` terminates synchronously and rejects queued requests. Separate
  actors cannot share guest globals.
- This is **cooperative browser execution separation**, not a security
  boundary: Web Workers share the web origin and JS privileges. Only compiled
  Wasm is instantiated; no user-supplied JS, eval or guest imports are allowed.

## Runtime implementation and limits

- `src/actor-abi.js` validates the exact source-free module contract.
- `src/actor-worker.js` owns one Wasm instance and executes mailbox messages.
- `src/actor-runtime.js` manages admission, deadlines and terminal closure.
- Real browser E2E runs a hand-assembled Wasm counter guest and proves
  independent per-worker state, FIFO updates, malformed message refusal and
  stop/restart behavior. The counter fixture is **not generated from AttoLang**.
- No guest actor names, supervisor-control messages, `handle_state(critical-*)`,
  ownership transfer, per-tenant isolation, `Result` wire encoding or replay-safe
  runtime handles yet. They remain separate compiler/runtime obligations.

## Next integration: compiler-generated actor guest

Lower a narrow `define actor` with scalar `receive(int)->int` through typed
IR into the exact v0 `receive(i64)->i64` export, while preserving AttoLang
source-level error/ownership rules. Add compiler-produced Wasm, not hand-built
fixture, as browser E2E and enforce exact compiler head/tree/receipt provenance.
Then extend to typed messages, sealed state, mailbox lifecycle, supervision,
actor groups and backend parity. Never silently erase actor members.

## Playground source-compiler integration (draft)

The `Start actor` button requests the explicit `actor` compilation mode from
the same **SHA-256-pinned** `src/compiler-worker.js` used for normal `main`.
The bridge calls the optional ABI v2 export `compile_actor(length)`; it never
falls back to `compile(length)`. When the approved, vendored compiler lacks the
new export, the UI must show `E_ACTOR_UNAVAILABLE` and produce no guest Wasm.

When present, `compile_actor` produces `receive(i64)->i64` guest Wasm.
The compiler bridge and app call `validateActorGuest`, and the actor worker
validates again before instantiation. `Send message` accepts only signed-i64
BigInt values. Worker startup is abortable; Stop, source edits, panic and
deadlines terminate the actor and reject outstanding requests.

**Current release gate:** the vendored compiler predates `compile_actor`.
Playground CI therefore verifies the rejection path and the separately
executed worker fixture, but must report the combined source-to-worker
browser execution as **NOT_EXECUTED**, not a pass. A later, independently
approved compiler vendor update must run `ATTO_REQUIRE_ACTOR_SOURCE_E2E=1`
on the exact pinned artifact, with receipt SHA/tree and real Chromium
execution, before this feature can be certified or published.
