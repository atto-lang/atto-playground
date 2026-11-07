# Browser Wasm actor substrate v0 — experimental

**Status: execution substrate and source-to-worker integration bridge.**
The bridge accepts output from the real Rust `compile_actor` compiler entry point,
but the currently vendored browser compiler does not yet export that entry
point. The UI rejects this mismatch with `E_ACTOR_ABI`; it **never** runs
a scalar `main()` guest as an actor or silently interprets Atto source in JS.
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
  *contiguous* sequence ID starting at 1, and processed synchronously by the
  worker. Skipped/replayed IDs are rejected **before** guest invocation; the
  host accepts results only in the same FIFO sequence. Out-of-order replies
  terminate the actor and reject all outstanding sends.
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
- `src/compiler.js` exposes `compileActor` only via a pinned compiler's real
  `compile_actor` Wasm export. The default old binary reports `E_ACTOR_ABI`.
- `src/actor-session.js` validates the guest Wasm ABI *before* spawning the
  worker; cancellation invalidates in-flight compilation/spawn completions.
- `src/actor-workbench.js` adds an opt-in actor example, start, send and stop
  controls while preserving the ordinary program runner.
- Real browser E2E runs a hand-assembled Wasm counter guest and proves
  independent per-worker state, FIFO updates, malformed message refusal and
  stop/restart behavior. The counter fixture is **not generated from AttoLang**.
- No guest actor names, supervisor-control messages, `handle_state(critical-*)`,
  ownership transfer, per-tenant isolation, `Result` wire encoding or replay-safe
  runtime handles yet. They remain separate compiler/runtime obligations.

## Next integration: approved compiler-generated actor guest

**Preferred compiler review sequence:** [consolidated compiler PR #15](https://github.com/atto-lang/atto-source.rs/pull/15)
followed by [actor ABI PR #19](https://github.com/atto-lang/atto-source.rs/pull/19).
PR #19 semantically integrates scalar `define actor` / `receive(int)->int`
onto the same compiler tree as the corrected canonical semantics, nominal enum
support and bounded class allocation. Its separate `compile_actor` export
produces the v0 `receive(i64)->i64` guest. The older divergent compiler
PR #10 and test PR #17 must **not** be merged as an independent competing
stack on top of the consolidated implementation.

After independent reviews and merges, obtain **separate approval to disclose**
the exact compiler artifact before replacing the pinned bytes, receipt or SHA.
The public site has an additional P0 administrator gate:
[atto-lang.github.io issue #5](https://github.com/atto-lang/atto-lang.github.io/issues/5)
documents a branch-source GitHub Pages publishing bypass that a checked-in
manual-dispatch workflow alone cannot close. Pages publishing source,
protected `main`, environment reviewers and negative live deployment tests
must be verified by an administrator before release.

Until these independent authorizations, the playground browser E2E correctly
checks `E_ACTOR_ABI` against its existing old compiler instead of inventing
actor support. Once an approved actor compiler is vendored, the same browser
E2E must compile editor source and execute `send(41) → 42` in a real worker.
Future release admission requires the exact source commit and tree, CI run, job,
artifact ID, and the compiler artifact's SHA-256 to match the reviewed
receipt and independently controlled release variables. The first actor-enabled
vendor update must supply source-owned CI receipt metadata; GitHub Actions
approval variables are not created automatically by a green test run.
The release gate verifies metadata consistency, **not** the authenticity of
an approval or the right to publish private source-built binaries. The
independent review and explicit public-disclosure decision remain required.

**Accidental-disclosure defense:** `scripts/vendor-compiler.sh` stages the
actor-enabled binary without changing checked-in public files until both
source-owned CI metadata and matching operator-supplied `ATTO_PUBLIC_*` values
are present. The separate Pages workflow checks independently administered
repository variables before deployment. **Local environment variables are
not an authentication mechanism**: do not commit/upload the newly vendored
binary to a public repository without a separately approved release and
actual authorization to disclose the private-source-built compiler.

Then extend to typed messages, sealed state, mailbox lifecycle, supervision,
actor groups and backend parity. Never silently erase actor members.
