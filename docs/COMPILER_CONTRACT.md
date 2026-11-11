# Playground compiler contract (v2)

The playground ships `public/atto_compiler.wasm`. It is built from [oreslang-source.rs/browser](https://github.com/ores-truffle-oreslang/oreslang-source.rs/pull/52) at the commit named in `public/atto_compiler.receipt.json`. It is a real AttoLang-to-WebAssembly compiler that itself runs as WebAssembly:

- No server compiles user source.
- No JavaScript evaluates user source.
- No LLVM runs in the page.

## Integrity

`scripts/vendor-compiler.sh` writes the compiler's SHA-256 and size to both the receipt and `src/compiler-pin.js`. The compiler worker fetches `atto_compiler.wasm?sha256=<prefix>`, so a cached copy from an older deploy is never reused. It then hashes the bytes and refuses to run a compiler that does not match the pin. The tests check the pin against the receipt and confirm that a one-bit change is rejected.

A trap inside the compiler instance would leave its state undefined. `createCompiler` therefore refuses further calls on an instance that trapped, and the page uses a fresh compiler worker for every run anyway. The compiler's resource limits are listed in canonical browser crate `README.md` under "Resource limits". Each limit is a diagnostic, never a trap.

## Language subset

The compiler adds no syntax of its own:

- **Syntax** follows the reference compiler (`oreslang-source.java` `docs/grammar.ebnf` / `Parser.java`).
- **`int`** follows the LLVM backend and spec chapter 17: signed 64-bit with checked arithmetic, where overflow is a panic.

| Area | Admitted |
| --- | --- |
| Declarations | `[pub] fnc` / `routine`, `: T` or `-> T`, brace body; parameters `int a`, `int mut a`; arity overloads |
| Entry point | zero-argument `main` returning `int` or `void` |
| Types | `int`, `bool` / `boolean`, `void` |
| Bindings | `val` / `const` (immutable), `let` (reassignable); `name: T`, `T name` or inferred |
| Control flow | `if … then … elif … else … fi`, brace form closed by `fi`, `while … do … done`, `loop { }`, `for (let i = 0; i < n; i++)`, `break`, `continue` |
| Expressions | `+ - *`, `< <= > >=`, `eq neq == !=`, `!`, ternary, `,` / `\|` in conditions (both sides are evaluated), `And` / `Or` / `Xor` |
| Output | `stdio.print` / `stdio.println` of `int`, `bool`, string literals and objects |
| Classes | `[pub] define class Name as … end`: fields, one `constructor`, private-by-default methods, `pub static fnc` called as `Name.f()`, `new Name(…)`, moves |
| Actors | `define actor Name as … end`: `let` state, `receive(ActorMail<int\|bool> mail): void`, `spawn Name()`, `ref.send(v)` |
| Enums | `define enum Name as A B end` (the oreslang-source.llvm v1 design spelling; Java does not parse it yet) |

The full rules are in canonical browser crate `README.md`. Each one was checked against the Java reference compiler.

Anything else is rejected with an `E_*` diagnostic, and a rejected program produces no artifact. That includes:

- `int / int`, whose result type is undecided (spec S-25), and the removed `%`, `^` and `^^`
- strings as values, floats and sized integers
- `match`, imports, lambdas, inheritance, enum payloads and calling actor methods directly

## Compiler ABI v2

The compiler has no imports and memory capped at 64 MiB. It exports:

- `abi_version()`, which returns 2
- `memory`, `input_ptr()` and `input_capacity()` (64 KiB of UTF-8)
- `compile(length)`, which returns 0 on success
- `result_ptr()` and `result_length()`, which are 0 after an error
- `error_ptr()`, a NUL-terminated `E_CODE: message`
- `error_line_number()` and `error_column_number()`

`src/compiler.js` checks the ABI version and output bounds. It copies the result out before the next compile.

## Guest contract `atto.browser.guest.v2`

- **Exports:** `main: () -> i64` and `panic_code: mut i32` (1 = integer overflow, 2 = division by zero, which is reserved, 3 = object heap exhausted). `memory` is exported for string literals, classes or actors. It is fixed and non-shared, with strings, aligned actor state slots and the object heap in disjoint regions; with classes it is 1 MiB. Programs with actors also export `actor_init` and `actor_receive`, and carry an `atto.actors` custom section of type names.
- **Imports:** only from module `atto`: `print_i64`, `print_bool`, `print_str` and `print_newline`, plus `actor_spawn` and `actor_send` for programs with actors. `src/guest.js` refuses any other import, validates the actor table, and caps stdout at 64 KiB.

### Tenant Workers and actor-private memories

The playground selects Wasm or compiler-emitted ESM. Both execute through `src/tenant-worker.js` and the pinned canonical `runTenantGuest` runtime from source.js. Every active tenant run owns exactly one Worker; all actors for that tenant execute inside it. No per-actor child Workers are created. The UI normally has one tenant; the host pool supports four concurrent tenant runs.

- Each actor gets a fresh instance with non-shared Wasm linear memory; its persistent state and heap cannot alias another actor's memory. Immutable module code may be reused.
- Actor turns run round-robin, with FIFO and sequence numbers preserved per actor. A MessageChannel task separates turns so the carrier event loop can make progress. Cross-actor output order is not a language guarantee.
- Limits: 16 actors, 10,000 accepted messages per actor, 20,000 aggregate messages, 1 MiB per instance and 16 MiB aggregate guest memory including main. Memory admission uses the compiler's fixed per-instance layout and rejects before allocating an over-budget actor. Browser/JS-engine overhead is outside this accounting.
- Main returns before mailbox drain; a panicking actor reports its name/id and fails its tenant. Other tenants have independent Workers and cancellation/deadlines.
- A noncooperative turn can stall its tenant. The parent terminates that Worker on Stop/deadline. Compiler-lowered Task suspension, await, cancellation fencing and cooperation checkpoints inside a turn remain required for the full Atto Task API. A callback or Promise alone is not that API.

`src/runner-worker.js`, `src/actor-host.js` and `src/actor-worker.js` remain legacy source fixtures for existing tests, but are not part of the new release allowlist.

Each guest runs in a fresh worker with a 3-second deadline, which ends infinite loops. Compilation has its own 10-second deadline, because the first run includes downloading the compiler. A timeout message names the phase that exceeded its deadline. A browser worker is not OS-level isolation, so the host must never grant other imports.

## Static release and disclosure gate

The reviewed static Pages artifact must be built by `scripts/package-pages.mjs`. Only the **34 enumerated browser assets** (HTML, CSS, JS including the actor workers, nine examples, compiler and formatter receipts and Wasm, and this contract) are shipped. The packager rejects symlinked inputs and staging directories, limits asset sizes, verifies compiler Wasm has no imports, enforces matching pinned digest, receipt and bytes, and emits per-file SHA-256 plus the source commit in `release-manifest.json`. It cannot be pointed at arbitrary source directories.

The Pages workflow is **not an auto-publisher**: deployment requires `workflow_dispatch` from `main`, affirmative binary-disclosure confirmation, and an administrator-managed GitHub Actions repository variable `ATTO_PUBLIC_COMPILER_SHA256` matching the workflow input, compiler receipt and actual bytes. It tests the actual staged site with Chromium before publishing. A green CI run alone does **not** imply permission to disclose compiler Wasm; independent review and GitHub Pages hosting eligibility are additional gates.

The earlier M0 guest restriction requiring exactly the type/function/export/code sections cannot apply to v2: `atto.browser.guest.v2` intentionally permits bounded stdout imports, memory for string literals and objects, and the bounded actor capabilities. The v2 guest runner instead enforces `guestImports()`'s allowlist, an i64 `main` entrypoint, a 1 MiB module-size ceiling, bounded output and a hard worker deadline.
