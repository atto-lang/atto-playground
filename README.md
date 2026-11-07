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

## Portable saved-program backups

The browser's **Export JSON** and **Import JSON** controls use an explicitly versioned offline backup format (30 named programs maximum; 64 KiB source per program; 512 KiB backup cap). Import validates all entries before a single localStorage write. Name conflicts require explicit overwrite approval; otherwise no entries are changed. Saves and imports fail closed on corrupted existing localStorage rather than silently erasing it. Switching away from modified custom code prompts before discarding edits; browser tab-close dialogs are intentionally not enabled because their behavior is inconsistent across browsers. Export a backup before clearing browser data. These features do not upload user code.
