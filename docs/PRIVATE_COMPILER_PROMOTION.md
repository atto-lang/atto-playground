# Private compiler promotion rehearsal

This is a private, read-only acceptance procedure. It does not approve public release or change the old compiler pin.

## Candidate identity

- Compiler source: atto-lang/atto-source.rs PR #15
- Exact source HEAD: e0ef984511ae0934d10ecf49284cad77d8861b2c
- Exact source Git tree: 9cfdaf877f76f47de6216ed89ee29dc801d78b4e
- Successful source CI: https://github.com/atto-lang/atto-source.rs/actions/runs/42410801241
- Private compiler artifact ID: 13589725767
- Compiler Wasm: 179634 bytes, SHA-256 bc86a7003aba50fc922f478a347e8ee921a3b016a2ca21ba8a3f3a84f5e0c4a6
- Artifact ZIP SHA-256: b625f3964acd8905370a72d8073848713f17edf71780d247f492aadb5558e624 (different object)
- Currently pinned public compiler: 91209eac9d875e3574d5f87a9a2e6e46f7622daa1169b79d31213f31ad78b657

## Run the private integration tests

With gh access to private source CI and Node 22, from this playground checkout:

    set -eu
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    gh run download 42410801241 -R atto-lang/atto-source.rs \
      -n atto-compiler-wasm32-e0ef984511ae0934d10ecf49284cad77d8861b2c -D "$tmp"
    node scripts/verify-private-candidate.mjs "$tmp/atto_compiler.wasm" "$tmp/receipt.json"

The script reads the candidate metadata from release-candidates/, compares immutable exact-head/tree provenance, verifies the compiler SHA-256 and import-free ABI, invokes the actual src/compiler.js adapter, and runs generated guest WebAssembly through src/guest.js. It tests class Point/new Point() returning 42, nominal enum execution, E_NEW_REQUIRED, E_UNKNOWN_FIELD, E_UNKNOWN_VARIANT, removed operators, actor-spawn rejection, eager boolean side effects, checked overflow, heap exhaustion panic code 3, and recovery. Compilation failures must have a diagnostic with no guest artifact.

Missing external binary or receipt causes a nonzero NOT_EXECUTED outcome; do not report the ordinary CI run as executed candidate evidence. The script never writes to public/, _site/, or any deployment branch. The candidate metadata and scripts/ remain excluded from the Pages package.

## Remaining approval and release boundary

These are private, Node-hosted guest integration tests, not real Chromium IDE tests on the candidate binary, not public HTTPS verification, and not Java/LLVM differential execution.

1. Obtain independent non-author review for the exact compiler head, binary bytes and playground integration. Authorship alone cannot approve.
2. Fix https://github.com/atto-lang/atto-lang.github.io/issues/5 in GitHub settings: change Pages Source to GitHub Actions; protect main and github-pages environment; prove ordinary main pushes and unapproved manual dispatch cannot publish.
3. After approval, vendor the candidate compiler, receipt and SHA-256 pin as a single reviewed change. Update the language contract, examples and outdated remainder/division panic scenarios to the removed-operator contract.
4. Run the full IDE Chromium suite with the new binary (source edits, Run, artifact download, negative diagnostic/no-artifact, cancellation, timeout, cache/digest, test/package exclusion). Only then request explicit public binary-disclosure approval.
5. Publish solely with protected manual workflow and verify live HTTPS Wasm hash, MIME, CSP, release manifest, forbidden paths and working Point/enum programs. Passing CI alone is not deployment evidence.
