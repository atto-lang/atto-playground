# AttoLang Playground

A self-hosted, static **Atto source → WebAssembly compiler → WebAssembly guest** demo. Both compiler and generated program execute inside the visitor's browser. No compilation server and no user-code uploads.

The compiler is [atto-lang/atto-source.rs](https://github.com/atto-lang/atto-source.rs), a Rust AttoLang compiler built for `wasm32-unknown-unknown`. It emits real binary Wasm, not a JavaScript simulation. It compiles a subset of AttoLang: functions, recursion, `int`/`bool`, bindings, `if`/`while`/`for`/`loop` and `stdio.println`. Its syntax follows the reference compiler, and everything outside the subset is rejected. See [the contract](docs/COMPILER_CONTRACT.md).

## Verify locally

Requires Node 20 or later. Python 3 is optional, for the HTTP server. There are no npm dependencies.

```sh
npm run verify          # receipt digest, compiler ABI, examples, guests, worker tests
npm run serve           # http://localhost:8080
CHROME_BIN=... npm run test:e2e   # 17 real-browser scenarios under /play/
```

To update the compiler, run `npm run vendor:compiler -- /path/to/clean/atto-source.rs`. It rebuilds the wasm and rewrites `public/atto_compiler.receipt.json` with the source head, tree, toolchain and sha256. CI fails if the shipped wasm does not match the receipt.

## Architecture

- `public/atto_compiler.wasm` and `public/atto_compiler.receipt.json`: the vendored compiler and its provenance.
- `src/compiler.js`: compiler ABI v2 bridge.
- `src/compiler-worker.js`: disposable compilation worker with a 3-second deadline.
- `src/runner-worker.js` and `src/guest.js`: a disposable guest worker. It grants only `atto.print_*`, caps stdout and maps panics to messages.
- `examples/*.atto`: the example programs. Each one is checked against the Java reference compiler.
- `src/app.js` and `index.html`: the static UI, examples, Wasm download and share links.

## Deployment

Host this directory on any static host, with `.wasm` served as `application/wasm`, strong CSP headers, and no user-controlled backend execution. For a domain like `play.attolang.org`, use a CNAME/host mapping managed by the website owner. The main language website can link directly to the playground. CI checks the compiler regeneration and Node tests; a green run must have nonzero executed job steps.
## E2E release gate

The full browser E2E suite checks a compiled 42 result, downloaded Wasm execution, stale-artifact invalidation on edits, mutable and immutable examples, syntax diagnostics, runtime traps, source limits, recovery, Unicode share-link reload, stop/restart cancellation, HTML-injection rejection and static-only HTTP traffic. It uses a disposable Chrome profile, an ephemeral DevTools port and a local static server. It is separate from the Node compiler test suite.

Passing Chromium E2E tests does **not** establish Firefox or WebKit coverage, a publicly deployed HTTPS route, or full AttoLang compiler compatibility. The current C bootstrap accepts only the documented M0 scalar subset; promotion to canonical Atto frontend and typed IR requires compiler-backed parity evidence and independent review.


## Browser editor UI

The accessible native editor provides a line gutter, line/column display, keyboard indentation, Ctrl/⌘+Enter to run, selectable diagnostics and Console/Diagnostics/Wasm tabs. Source code stays in the browser; output and downloaded Wasm are invalidated on edits. `src/editor.js` and `src/ui.js` are explicit required release assets and are covered by Node and Chromium E2E tests.

## Custom programs and syntax highlighting

Choose **Custom +** in the Program selector to keep the current editor text as a custom draft. Enter a name and click **Save**. Saved programs reappear in the same dropdown on the same browser origin after refresh; clicking an existing name loads it and Save overwrites that name. Delete removes the saved copy but keeps current editor text. Storage is explicitly local, capped at 30 named programs / 64 KiB per program, and may be disabled by browser privacy settings. Storage is scoped to the browser origin (scheme, host, and port), not the URL path: `/play/` and `/atto-playground/` on `atto-lang.github.io` share it, while a different host does not. No source is submitted to a compilation service.

The highlighting mirror uses conservative token classes based on the Oreslang formatter's lexical/comment rules. It cannot replace the formatter's Rust semantics or validate syntax. Real typing and assistive access remain on the native textarea; the highlight layer only accepts DOM text nodes and has no HTML interpreter.

## Canonical browser formatter

The **Format** and **Check format** actions run the real Rust `oreslang-format` library compiled to a separate, import-free `wasm32-unknown-unknown` module. The precompiled 198230-byte Wasm artifact has a SHA-256 pin and source-commit receipt; no user code is sent to a formatting server. A disposable worker imposes a 6-second deadline. Format edits only on success, preserves approximate caret positions and uses browser-native undo where supported. Check format never edits code. `Alt+Shift+F` invokes Format. The formatter is a formatting tool, **not** the AttoLang type checker or a guarantee of compiler acceptance.

### Fibonacci pattern matching

The **Fibonacci — pattern matching** option compiles `return match n over ... end` with the actual pinned Rust/Wasm compiler (same guest output as the original if/fi recursion sample, `main() = 144`). The expression-style arms are supported in `return` position; ordinary statement-level `match` also remains supported. Other value-match positions are outside this compiler subset. No JavaScript rewriting is used.
