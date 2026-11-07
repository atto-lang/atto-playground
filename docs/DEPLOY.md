# Deploying AttoLang Playground

The build is **static**: browsers download the compiler Wasm and generate/run guest Wasm locally, without sending source to a compilation server.

## GitHub Pages project site

This repository includes `.github/workflows/pages.yml`. Enable **Settings → Pages → Build and deployment → GitHub Actions** (subject to the organization's private-repository Pages eligibility). After independently reviewed merges into `main`, an administrator must explicitly approve binary disclosure and manually dispatch the workflow; a merge alone does not publish the compiler.

Expected default project URL after successful deployment (not verified live yet):

`https://atto-lang.github.io/atto-playground/`

The workflow publishes the vendored `public/atto_compiler.wasm` only after `npm run verify` confirms it matches `public/atto_compiler.receipt.json`. The receipt names the atto-source.rs source head and tree, the pinned Rust toolchain and the SHA-256. `scripts/vendor-compiler.sh` reproduces the same bytes from that commit.

## Custom subdomain

If the organization controls an AttoLang domain, map an approved `play.<domain>` custom hostname to the GitHub Pages project deployment, or host the same static assets with a CDN supporting such hostnames. Set DNS only after verifying domain ownership and the GitHub Pages custom domain configuration. No domain or DNS is configured by this repository.

For Cloudflare Pages, build command `npm run verify`, output directory `_site` after running the same packaging commands as the Pages workflow. Serve `.wasm` with `application/wasm` and strong cache controls for versioned assets. The HTTP CSP should enforce `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. Add security headers `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `frame-ancestors 'none'` in HTTP headers (not via CSP meta).

## Integration

Add a `Playground` navigation item in the AttoLang language website that points at the **verified live URL**. The `atto-co` company site can link to that same URL. Do not imply that a custom domain is live before DNS and deployment are independently checked.

## Security

A guest may import only the `atto.print_*` output functions, and stdout is capped. `main` returns i64. Compilation and execution are isolated into disposable browser workers with a bounded time budget. Browser workers are not OS-level isolation. Do not expose arbitrary host imports to user Wasm, and do not claim full-language parity or a production-grade sandbox based on these tests alone.

### Unpublished staging is fail-closed on compiler upgrades

The package builder permits the **unchanged historical pinned compiler** in ordinary CI staging, so pre-release verification of source/worker changes continues without publishing new compiler bytes. Its fixed baseline binds the compiler SHA-256, byte count, source repository, exact commit, and Git tree. Changing any of those fields without the explicitly supplied release-approved compiler digest makes `scripts/package-pages.mjs` refuse to stage `_site`, even if the new receipt and binary agree internally. This is a defense-in-depth guard against accidentally packaging an unapproved compiler, not an approval of the historical binary for publication.

A matching `approvedCompilerSha256` value only satisfies this **local** staging check. Actual public distribution still requires independent review of the exact compiler source head/tree and artifact bytes, administrator-controlled `ATTO_PUBLIC_COMPILER_SHA256`, a manual affirmative workflow dispatch on protected `main`, and the protected `github-pages` deployment environment. Neither a PR comment nor an editable CI argument is independent release authorization. The new source-level actor browser E2E must be executed against the approved vendor artifact rather than inferred from hand-built worker guest tests.

## GitHub Actions release

1. Independently approve all release PR heads and merge in dependency order. Verify the deployed release uses the exact audited `main` commit.
2. An authorized repository administrator sets the GitHub Actions variable `ATTO_PUBLIC_COMPILER_SHA256` to the reviewed SHA-256 from the source-controlled compiler receipt; the compiler is publicly inspectable after release.
3. On `main`, open **Actions → Publish approved AttoLang playground → Run workflow**; enter the exact compiler SHA-256 and choose **yes** for public binary disclosure.
4. The build rejects mismatched digests, builds a fixed allowlist, and runs full Chromium source-to-Wasm-to-guest E2E on the staged published files. The deployment uses GitHub Pages OIDC credentials with no long-lived token.
5. Verify the actual HTTPS URL and its `public/atto_compiler.wasm` content type and digest before linking it publicly.

A public `atto-lang.github.io/play/` route is being prepared separately. Do not copy the private compiler to a public repository as a workaround without the same explicit binary-disclosure approval and review.


### Required GitHub administration before the first public release

Protect `main` against unreviewed changes and configure the `github-pages` environment with **required reviewers** in the repository Settings. Independent reviewers must approve the exact compiler-vendor commit and binary SHA-256. Restrict who can change `ATTO_PUBLIC_COMPILER_SHA256`; the variable alone does not prove independent review. Do not dispatch the public release until those controls and GitHub Pages hosting eligibility are verified by a repository administrator. The static site is not an OS security sandbox.
