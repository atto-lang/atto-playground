# Playground compiler contract (v2)

The playground ships `public/atto_compiler.wasm`. It is built from [atto-lang/atto-source.rs](https://github.com/atto-lang/atto-source.rs) at the commit named in `public/atto_compiler.receipt.json`. It is a real AttoLang-to-WebAssembly compiler that itself runs as WebAssembly:

- No server compiles user source.
- No JavaScript evaluates user source.
- No LLVM runs in the page.

## Integrity

`scripts/vendor-compiler.sh` writes the compiler's SHA-256 and size to both the receipt and `src/compiler-pin.js`. The compiler worker fetches `atto_compiler.wasm?sha256=<prefix>`, so a cached copy from an older deploy is never reused. It then hashes the bytes and refuses to run a compiler that does not match the pin. The tests check the pin against the receipt and confirm that a one-bit change is rejected.

A trap inside the compiler instance would leave its state undefined. `createCompiler` therefore refuses further calls on an instance that trapped, and the page uses a fresh compiler worker for every run anyway. The compiler's resource limits are listed in atto-source.rs `README.md` under "Resource limits". Each limit is a diagnostic, never a trap.

## Language subset

The compiler adds no syntax of its own:

- **Syntax** follows the reference compiler (`oreslang-source.java` `docs/grammar.ebnf` / `Parser.java`).
- **`int`** follows the LLVM backend and spec chapter 17: signed 64-bit with checked arithmetic, where overflow is a panic.

| Area | Admitted |
| --- | --- |
| Declarations | `[pub] fnc` / `routine`, `: T` or `-> T`, brace body; parameters `int a`, `int mut a`; arity overloads |
| Entry point | zero-argument `main` returning `int` or `void` |
| Types | `int`, `bool` / `boolean`, `float` / `f64` (binary64), `string` / `String`, `void` |
| Bindings | `val` / `const` (immutable), `let` (reassignable); `name: T`, `T name` or inferred; immutable `int x = 7;` for `int`, `bool`, `string`, `String` |
| Control flow | `if … then … elif … else … fi`, brace form closed by `fi`, `while … do … done`, `loop { }`, `for (let i = 0; i < n; i++)`, `break`, `continue`, `match` (legacy arms and canonical `match x over on P -> { } end`; literal, `_`, binding and `Enum.Variant` patterns; guards; exhaustiveness checked); `return match x over on 0 -> 0, default -> expr, end` with required `end` and checked return types |
| Expressions | `+ - *` (int, float; an int operand widens), `/` with a float operand, `+` of two strings, `< <= > >=` (numbers; strings in Java `compareTo` order), `eq neq == !=`, `!`, ternary, `,` / `\|` in conditions (both sides are evaluated), `And` / `Or` / `Xor` |
| Output | `stdio.print` / `stdio.println` of `int`, `bool`, `float` (Java `Double.toString`), strings and objects |
| Strings | `trim()`, `starts_with`, `ends_with`, `contains_literal`; content `eq` |
| Classes | `[pub] define class Name as … end`: fields, one `constructor`, private-by-default methods, `pub static fnc` called as `Name.f()`, `new Name(…)`, moves |
| Actors | `define actor Name as … end`: `let` state, `receive(ActorMail<int\|bool> mail): void`, `spawn Name()`, `ref.send(v)` |
| Enums | `define enum Name as A B end` (the oreslang-source.llvm v1 design spelling; Java does not parse it yet) |

The full rules are in atto-source.rs `README.md`. Each one was checked against the Java reference compiler.

Anything else is rejected with an `E_*` diagnostic, and a rejected program produces no artifact. That includes:

- `int / int`, whose result type is undecided (spec S-25), and the removed `%`, `^` and `^^`
- unsupported sized integers and string/float **literal patterns** (ordinary string and float values are supported)
- general value-position `match` expressions (such as `val x = match ...`); return-position `match ... over ... end` and statement matches are supported
- imports, lambdas, inheritance, enum payloads and calling actor methods directly

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

- **Exports:** `main: () -> i64` and `panic_code: mut i32` (1 = integer overflow, 2 = division by zero, which is reserved, 3 = heap exhausted (objects and joined strings)). `memory` is exported only for string literals or classes, and with classes it is a fixed 1 MiB. Programs with actors also export `actor_init` and `actor_receive`, and carry an `atto.actors` custom section of type names.
- **Imports:** only from module `atto`: `print_i64`, `print_bool`, `print_str`, `print_newline` and `print_f64` (formatted like Java `Double.toString` by `formatJavaDouble` in `src/guest.js`), plus `actor_spawn` and `actor_send` for programs with actors. `src/guest.js` refuses any other import, validates the actor table, and caps stdout at 64 KiB.

### Actors in Web Workers

`src/runner-worker.js` runs `main`. When a guest has actors, `src/actor-host.js` grants `actor_spawn` and `actor_send`:

- Each `spawn` starts one dedicated Web Worker (`src/actor-worker.js`) with a private copy of the module. Actor state lives in that instance's globals, so actors share no memory.
- `send` posts mail with sequence numbers from 0. The actor worker handles mail strictly in order and reports each completion. The host rejects out-of-order or unexpected replies.
- Limits: 16 actors per run and 10,000 messages per actor (`E_ACTOR_LIMIT`, `E_MAILBOX_FULL`). Actors cannot spawn or send.
- The run ends when `main` has returned and every mailbox has drained, which matches the Java reference. Output from different actors may interleave in any order.
- A panicking actor fails the run as `E_PANIC: … in actor Name#n` and stops receiving mail.
- Stop and the 3-second deadline terminate the runner worker, which ends every actor worker it owns.

Each guest runs in a fresh worker with a 3-second deadline, which ends infinite loops. Compilation has its own 10-second deadline, because the first run includes downloading the compiler. A timeout message names the phase that exceeded its deadline. A browser worker is not OS-level isolation, so the host must never grant other imports.

## Static release and disclosure gate

The reviewed static Pages artifact must be built by `scripts/package-pages.mjs`. Only the **explicitly enumerated browser assets** (HTML, CSS, JS including the actor workers, the 13 built-in examples, compiler and formatter receipts and Wasm, and this contract) are shipped. The packager rejects symlinked inputs and staging directories, limits asset sizes, verifies compiler Wasm has no imports, enforces matching pinned digest, receipt and bytes, and emits per-file SHA-256 plus the source commit in `release-manifest.json`. It cannot be pointed at arbitrary source directories.

The Pages workflow is **not an auto-publisher**: deployment requires `workflow_dispatch` from `main`, affirmative binary-disclosure confirmation, and an administrator-managed GitHub Actions repository variable `ATTO_PUBLIC_COMPILER_SHA256` matching the workflow input, compiler receipt and actual bytes. It tests the actual staged site with Chromium before publishing. A green CI run alone does **not** imply permission to disclose compiler Wasm; independent review and GitHub Pages hosting eligibility are additional gates.

The earlier M0 guest restriction requiring exactly the type/function/export/code sections cannot apply to v2: `atto.browser.guest.v2` intentionally permits bounded stdout imports, memory for string literals and objects, and the bounded actor capabilities. The v2 guest runner instead enforces `guestImports()`'s allowlist, an i64 `main` entrypoint, a 1 MiB module-size ceiling, bounded output and a hard worker deadline.

## Experimental Wasm JSPI suspension and tasks (private, executable)

The Program dropdown offers **suspends / await (Wasm JSPI)** and **task { } / Future (Wasm JSPI)**. The Rust/Wasm compiler **does** emit guest binary modules for them, marked by the custom section `atto.async` containing version byte `2`. The runner checks this opt-in marker before permitting new imports and rejects unmarked/unsupported versions. This extends the existing guest v2 ABI, rather than silently changing non-async programs.

The only admitted async imports are `atto.sleep_ms(i64)->i64`, test-only `atto.barrier(i64)->i64`, `atto.task_start(i32)->i32`, and `atto.task_await(i32)->i64`, plus mandatory `atto.cooperate()->void` at **every** source-level `await`. Capture-free task bodies are **real Wasm functions** dispatched via `task_invoke(i32)->i64`; the browser host owns handles and scheduling, and JSPI `WebAssembly.Suspending` + `WebAssembly.promising` suspend and resume the Wasm stack across approved async boundaries. No JavaScript source evaluation, JS rewrite, or eager sequential fallback is used.

The supported subset comprises suspending top-level functions, explicit awaits, `Future<int>` task handles and child task blocks with no captures. Handles are consumed once. Real Chromium E2E tests run both examples and a two-party barrier demonstrating overlapping task execution; compiler errors still produce zero Wasm. Worker scope owns cancellation, a bounded task count, and a wall-clock deadline. A browser without JSPI fails closed with `E_ASYNC`.

**Not implemented:** portable CPS/frame lowering, arbitrary future result types, `do task`, closure captures, actor/task composite supervision, general async IO, cross-backend parity, and production-grade async cancellation under all races. The `rt.sleep` name is experimental browser-subset API, not a ratified cross-backend standard library contract. [Compiler PR #50](https://github.com/atto-lang/atto-source.rs/pull/50). Public compiler deployment requires independent review, explicit SHA approval and secure Pages-only publication; nothing here authorizes public binary disclosure.

### Syntax and type semantics for immediate await

`await 42;` and `return await 42;` are supported **only** inside an explicitly marked `suspends fnc` or `suspends mtd`. They emit a required `atto.cooperate` import and version-2 `atto.async` marker; the Worker event loop is given a separate turn before resumption, even for an already-available scalar or completed Future. Pending futures and timer imports still use JSPI. A non-suspending callable produces `E_EFFECT` with no guest Wasm, not a parser error. Actor suspends mtd is not admitted until actor-owned scheduling is implemented; supervisor control threads never execute these continuations. Old v1 async modules are rejected by the host to avoid weaker semantics.

### Actor-owned `suspends receive` experimental slice

The browser compiler supports `suspends receive(ActorMail<int> mail): void` and actor-local `suspends mtd` with explicit `await` effects. A dedicated actor Web Worker instantiates its **own** guest Wasm module and its own scoped JSPI task host. Incoming mail forms a strictly serialized Promise chain: although `await` yields the browser carrier, a second message to that actor cannot reenter its suspended handler; sibling actor Workers still run. Synthetic capture-free `task { ... }` bodies are dispatched through `task_invoke` on that actor's own Wasm instance, never on the runner or supervisor CONTROL pool.

Each actor invocation is generation fenced and handles are single-use. Stale generation acknowledgements and stdout are ignored by the parent. On cancellation/failure, the worker task scope closes and the actor fails without restarting unsupervised. Real Chromium acceptance checks sibling progress while suspended, FIFO/nonreentrant mailbox state, actor-owned structured child task, Stop cancellation and next-run recovery. This is browser Worker isolation, **not** yet a portable actor heap/stack scheduler or independently tested supervisor restart across host processes. No public compiler or Pages deployment is authorized by these tests.
