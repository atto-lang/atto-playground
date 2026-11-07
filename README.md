# AttoLang Playground

A self-hosted, static **Atto source → WebAssembly compiler → WebAssembly guest** demo. Both compiler and generated program execute inside the visitor's browser. No compilation server and no user-code uploads.

The compiler is [atto-lang/atto-source.rs](https://github.com/atto-lang/atto-source.rs), a Rust AttoLang compiler built for `wasm32-unknown-unknown`. It emits real binary Wasm, not a JavaScript simulation. It compiles a subset of AttoLang: functions, recursion, `int`/`bool`, bindings, `if`/`while`/`for`/`loop` and `stdio.println`. Its syntax follows the reference compiler, and everything outside the subset is rejected. See [the contract](docs/COMPILER_CONTRACT.md).

## Verify locally

Requires Node 20 or later. Python 3 is optional, for the HTTP server. There are no npm dependencies.

```sh
npm run verify          # receipt digest, compiler ABI, examples, guests, worker tests
npm run serve           # http://localhost:8080
CHROME_BIN=... npm run test:e2e   # 16 real-browser scenarios under /play/
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
