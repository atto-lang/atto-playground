> **AI agent instructions (organization-wide):** Before working on code, issues, or pull requests, read and follow the [organization `AGENTS.md`](https://github.com/atto-lang/.github/blob/main/AGENTS.md), including its **merge-first stealth-development policy**. Honor any repository-local `AGENTS.md`, explicit holds, and GitHub-enforced rules.

# AttoLang Playground

A self-hosted, static **Atto source → WebAssembly compiler → WebAssembly guest** demo. Both compiler and generated program execute inside the visitor's browser. No compilation server and no user-code uploads.

The compiler is [atto-lang/atto-source.rs](https://github.com/atto-lang/atto-source.rs), a Rust AttoLang compiler built for `wasm32-unknown-unknown`. It emits real binary Wasm, not a JavaScript simulation. It compiles a subset of AttoLang: functions, recursion, `int`/`bool`, bindings, `if`/`while`/`for`/`loop` and `stdio.println`. Its syntax follows the reference compiler, and everything outside the subset is rejected. See [the contract](docs/COMPILER_CONTRACT.md).

## Canonical AttoLang naming and language authority

This is the canonical [atto-playground](https://github.com/atto-lang/atto-playground) repository. All current instructions and source examples use AttoLang, `.atto`, and `atto-*` repository names. [atto-spec](https://github.com/atto-lang/atto-spec) defines normative language semantics, and [atto-platform-conformance](https://github.com/atto-lang/atto-platform-conformance) tracks independently executed guest evidence. The [Rust browser compiler](https://github.com/atto-lang/atto-source.rs) is distinct from [Wasm backend integration](https://github.com/atto-lang/atto-source.wasm); neither project name nor a browser UI guarantees full language support.

## Verify locally

Requires Node 20 or later for the checked-in Node verification. There are no npm dependencies. The `serve` command is a loopback-only, dependency-free Node static server. It restricts access to the Pages asset allowlist, serves WebAssembly with the correct MIME type, rejects symlinks/path traversal and applies CSP headers; it never compiles user source on a server.

```sh
npm run verify          # receipt digest, compiler ABI, examples, guests, worker tests
npm run serve           # http://127.0.0.1:8080, loopback only
CHROME_BIN=... npm run test:e2e   # 17 real-browser scenarios under /play/
```

To update the compiler, run `npm run vendor:compiler -- /path/to/clean/atto-source.rs`. It rebuilds the wasm and rewrites `public/atto_compiler.receipt.json` with the source head, tree, toolchain and sha256. CI fails if the shipped wasm does not match the receipt.

## Architecture

- `public/atto_compiler.wasm` and `public/atto_compiler.receipt.json`: the vendored compiler and its provenance.
- `src/compiler.js`: compiler ABI v2 bridge.
- `src/compiler-worker.js`: disposable compilation worker with a 3-second deadline.
- `src/runner-worker.js`, `src/tenant-actor-host.js`, and `src/guest.js`: a disposable tenant guest worker. One compiled module is instantiated per actor, with independent memories/globals, a round-robin mailbox scheduler, bounded stdout, and actor-local trap handling.
- `examples/*.atto`: the example programs. Each one is checked against the Java reference compiler.
- `src/app.js` and `index.html`: the static UI, examples, Wasm download and share links.

The current guest ABI is synchronous: `actor_receive` cannot suspend, and a runaway Wasm call cannot be preempted within one tenant Worker. The parent 3-second deadline still terminates the whole tenant; compiler-lowered continuations and instruction budgets are required before declaring arbitrary untrusted actors independently CPU-isolated. A scalar-only actor compiled by the currently pinned compiler may have no linear memory export; the current Rust source compiler includes bounded actor memory (atto-source.rs PR #61 merged) and must be vendored through the existing provenance gate before this property is guaranteed for all playground actors.

## Deployment

Host this directory on any static host, with `.wasm` served as `application/wasm`, strong CSP headers, and no user-controlled backend execution. For a domain like `play.attolang.org`, use a CNAME/host mapping managed by the website owner. The main language website can link directly to the playground. CI checks the compiler regeneration and Node tests; a green run must have nonzero executed job steps.
## E2E release gate

The full browser E2E suite checks a compiled 42 result, downloaded Wasm execution, stale-artifact invalidation on edits, mutable and immutable examples, syntax diagnostics, runtime traps, source limits, recovery, Unicode share-link reload, stop/restart cancellation, HTML-injection rejection and static-only HTTP traffic. It uses a disposable Chrome profile, an ephemeral DevTools port and a local static server. It is separate from the Node compiler test suite.

Passing Chromium E2E tests does **not** establish Firefox or WebKit coverage, a publicly deployed HTTPS route, or full AttoLang compiler compatibility. The currently pinned browser compiler supports only the documented subset; new typed frontend profiles require compiler-backed guest parity evidence and independent review before publication.


## Browser editor UI

The accessible native editor provides a line gutter, line/column display, keyboard indentation, Ctrl/⌘+Enter to run, selectable diagnostics and Console/Diagnostics/Wasm tabs. Source code stays in the browser; output and downloaded Wasm are invalidated on edits. `src/editor.js` and `src/ui.js` are explicit required release assets and are covered by Node and Chromium E2E tests.

## Custom programs and syntax highlighting

Choose **Custom +** in the Program selector to keep the current editor text as a custom draft. Enter a name and click **Save**. Saved programs reappear in the same dropdown on the same browser origin after refresh; clicking an existing name loads it and Save overwrites that name. Delete removes the saved copy but keeps current editor text. Storage is explicitly local, capped at 30 named programs / 64 KiB per program, and may be disabled by browser privacy settings. Storage is scoped to the browser origin (scheme, host, and port), not the URL path: `/play/` and `/atto-playground/` on `atto-lang.github.io` share it, while a different host does not. No source is submitted to a compilation service.

The highlighting mirror uses conservative token classes based on the AttoLang formatter's lexical/comment rules. It cannot replace the formatter's Rust semantics or validate syntax. Real typing and assistive access remain on the native textarea; the highlight layer only accepts DOM text nodes and has no HTML interpreter.

## Canonical browser formatter

The **Format** and **Check format** actions run the actual Rust formatter implementation compiled to a separate, import-free `wasm32-unknown-unknown` module. The precompiled 198230-byte Wasm artifact has a SHA-256 pin and source-commit receipt; no user code is sent to a formatting server. A disposable worker imposes a 6-second deadline. Format edits only on success, preserves approximate caret positions and uses browser-native undo where supported. Check format never edits code. `Alt+Shift+F` invokes Format. The formatter is a formatting tool, **not** the AttoLang type checker or a guarantee of compiler acceptance.

## Portable saved-program backups

The browser's **Export JSON** and **Import JSON** controls use an explicitly versioned offline backup format (30 named programs maximum; 64 KiB source per program; 512 KiB backup cap). Import validates all entries before a single localStorage write. Name conflicts require explicit overwrite approval; otherwise no entries are changed. Saves and imports fail closed on corrupted existing localStorage rather than silently erasing it. Switching away from modified custom code prompts before discarding edits; browser tab-close dialogs are intentionally not enabled because their behavior is inconsistent across browsers. Export a backup before clearing browser data. These features do not upload user code.

## Repository ownership and contribution routing

**Belongs here:** Static IDE/playground UI, browser compiler packaging, pinned Wasm compiler receipts, example programs and browser/Node smoke tests.

**Belongs elsewhere:** The Rust-to-Wasm compiler source belongs in atto-source.rs; language-site marketing in atto-lang.github.io; JS-transpiler core in atto-source.js.

**Security and portability boundary:** Compilation and guest execution must be local to the visitor for advertised offline/static paths. Pin binary SHA, imports and headers; cap fuel/output/memory, isolate disposable workers, and gate deployment on exact-tree executed browser tests.

AttoLang is the canonical project identity; use `.atto` and current `atto-lang` repository links in new documentation. This README defines scope, not feature readiness. This README defines scope, not feature readiness.

**Acceptance:** name exact source SHA/tree, runtime/toolchain, positive and negative checks and execution receipt before claiming support. Host-only tests and empty CI steps do not prove guest execution.
