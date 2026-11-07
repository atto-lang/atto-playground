# Playground compiler contract (v2)

The playground ships `public/atto_compiler.wasm`. It is built from [atto-lang/atto-source.rs](https://github.com/atto-lang/atto-source.rs) at the commit named in `public/atto_compiler.receipt.json`. It is a real AttoLang-to-WebAssembly compiler that itself runs as WebAssembly:

- No server compiles user source.
- No JavaScript evaluates user source.
- No LLVM runs in the page.

## Integrity

`scripts/vendor-compiler.sh` writes the compiler's SHA-256 and size to both the receipt and `src/compiler-pin.js`. The compiler worker fetches `atto_compiler.wasm?sha256=<prefix>`, so a cached copy from an older deploy is never reused. It then hashes the bytes and refuses to run a compiler that does not match the pin. The tests check the pin against the receipt and confirm that a one-bit change is rejected.

The release packager checks the exact compiler export surface against the
receipt's optional `actor_abi: "atto.browser.actor.scalar.v0"` claim. This
field is present **only** if the binary has a real `compile_actor` export;
missing/forged claims reject packaging. Releasing new compiler bytes still
requires separately authorized source provenance and public disclosure.

A trap inside the compiler instance would leave its state undefined. `createCompiler` therefore refuses further calls on an instance that trapped, and the page uses a fresh compiler worker for every run anyway. The compiler's resource limits are listed in atto-source.rs `README.md` under "Resource limits". Each limit is a diagnostic, never a trap.

## Language subset

The compiler adds no syntax of its own:

- **Syntax** follows the reference compiler (`oreslang-source.java` `docs/grammar.ebnf` / `Parser.java`).

**Known semantics drift in the currently pinned legacy compiler:** it predates
AttoLang compiler semantic fix PR #4 and still admits removed arithmetic
operators such as `%` while retaining its earlier condition evaluation behavior.
That legacy behavior is tested only as a compatibility fact, **not** certified
as canonical AttoLang. The corrected source-owned compiler must undergo the
independent release process before the published binary can change.
- **`int`** follows the LLVM backend and spec chapter 17: signed 64-bit with checked arithmetic, where overflow is a panic.

| Area | Admitted |
| --- | --- |
| Declarations | `[pub] fnc` / `routine`, `: T` or `-> T`, brace body; parameters `int a`, `int mut a`; arity overloads |
| Entry point | zero-argument `main` returning `int` or `void` |
| Types | `int`, `bool` / `boolean`, `void` |
| Bindings | `val` / `const` (immutable), `let` (reassignable); `name: T`, `T name` or inferred |
| Control flow | `if … then … elif … else … fi`, brace form closed by `fi`, `while … do … done`, `loop { }`, `for (let i = 0; i < n; i++)`, `break`, `continue` |
| Expressions | Current pinned legacy compiler: `+ - * %` and listed comparisons/conditions. Canonical correction PR #4 rejects `%`, `^`, `^^` and evaluates condition operands eagerly. |
| Output | `stdio.print` / `stdio.println` of `int`, `bool` and string literals |

Anything else is rejected with an `E_*` diagnostic, and a rejected program produces no artifact. That includes:

- `int / int`, whose result type is undecided (spec S-25)
- strings as values, floats and sized integers
- class instances, actor state, source-level spawn, `match`, imports and lambdas

## Compiler ABI v2

The compiler has no imports and memory capped at 64 MiB. It exports:

- `abi_version()`, which returns 2
- `memory`, `input_ptr()` and `input_capacity()` (64 KiB of UTF-8)
- `compile(length)`, which returns 0 on success
- Optional `compile_actor(length)` on separately reviewed newer compiler builds. It
  emits an import-free `receive(i64)->i64` guest for the experimental actor worker
  ABI `atto.browser.actor.scalar.v0`; **never** fallback to `compile` for actors.
  The currently pinned compiler lacks this export; actor controls fail closed
  with `E_ACTOR_ABI` until an approved, receipted Wasm is vendored.
- `result_ptr()` and `result_length()`, which are 0 after an error
- `error_ptr()`, a NUL-terminated `E_CODE: message`
- `error_line_number()` and `error_column_number()`

`src/compiler.js` checks the ABI version and output bounds. It copies the result out before the next compile.

## Guest contract `atto.browser.guest.v1`

- **Exports:** `main: () -> i64`, `panic_code: mut i32` (1 = integer overflow, 2 = division by zero), and `memory` only when string literals are printed.
- **Imports:** only from module `atto`: `print_i64`, `print_bool`, `print_str` and `print_newline`. `src/guest.js` refuses any other import and caps stdout at 64 KiB.

Each guest runs in a fresh worker with a 3-second deadline, which ends infinite loops. Compilation has its own 10-second deadline, because the first run includes downloading the compiler. A timeout message names the phase that exceeded its deadline. A browser worker is not OS-level isolation, so the host must never grant other imports.

## Experimental browser actor substrate

The separate `atto.browser.actor.scalar.v0` ABI is described in
[ACTOR_BROWSER_ABI.md](ACTOR_BROWSER_ABI.md). It executes validated,
source-free `receive(i64)->i64` guest modules in dedicated Web Workers with
per-actor mutable Wasm global state, FIFO mailboxes, bounded admission and
worker termination on deadline, trap, or protocol error. **This is not yet
AttoLang `define actor` code generation or browser actor-language parity.**
It does not change the existing `atto.browser.guest.v1` compiler ABI.

## Static release and disclosure gate

The reviewed static Pages artifact must be built by `scripts/package-pages.mjs`. Only explicitly enumerated browser assets (HTML, CSS, JS, six examples, compiler receipt, compiler Wasm and this contract) are shipped. The packager rejects symlinked inputs and staging directories, limits asset sizes, verifies compiler Wasm has no imports, enforces matching pinned digest, receipt and bytes, and emits per-file SHA-256 plus the source commit in `release-manifest.json`. It cannot be pointed at arbitrary source directories.

For any actor-enabled compiler release, `scripts/actor-release-gate.mjs`
additionally requires its source SHA, exact tree SHA, GitHub CI run/job/artifact
IDs, and CI artifact digest to match administrator-managed approval values.
Ordinary pull-request CI never supplies these values and cannot authorize a
new compiler binary. The source-owned artifact must still be independently
reviewed for publication.

The Pages workflow is **not an auto-publisher**: deployment requires `workflow_dispatch` from `main`, affirmative binary-disclosure confirmation, and an administrator-managed GitHub Actions repository variable `ATTO_PUBLIC_COMPILER_SHA256` matching the workflow input, compiler receipt and actual bytes. It tests the actual staged site with Chromium before publishing. A green CI run alone does **not** imply permission to disclose compiler Wasm; independent review and GitHub Pages hosting eligibility are additional gates.

The earlier M0 guest restriction requiring exactly the type/function/export/code sections cannot apply to v2: `atto.browser.guest.v1` intentionally permits bounded stdout imports and memory for string literals. The v2 guest runner instead enforces `guestImports()`'s allowlist, an i64 `main` entrypoint, a 1 MiB module-size ceiling, bounded output and a hard worker deadline.
