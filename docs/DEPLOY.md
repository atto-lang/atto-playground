# Deploying AttoLang Playground

The build is **static**: browsers download the compiler Wasm and generate/run guest Wasm locally, without sending source to a compilation server.

## GitHub Pages project site

This repository includes `.github/workflows/pages.yml`. Enable **Settings → Pages → Build and deployment → GitHub Actions** (subject to the organization's private-repository Pages eligibility). **Merging to `main` no longer deploys automatically.** A public deployment exposes the compiler Wasm to all visitors and requires separate approval for its exact SHA-256.

Before a release, an authorized administrator must set repository Actions variable `ATTO_PUBLIC_COMPILER_SHA256` to the **exact approved 64-character lowercase SHA-256** of `public/atto_compiler.wasm`. Require independent review of source/compiler receipt and configure the `github-pages` environment with **required reviewers** in Settings; workflow YAML cannot impose reviewer protection on its own. After approvals, manually dispatch **Publish approved AttoLang playground** from `main`, supply that SHA-256 and select **yes** for public disclosure. The job fails closed when the variable is unset, the requested hash differs, or the bundled Wasm bytes differ. Remove or rotate the variable when withdrawing approval. Only authorized administrators should modify the release variable and environment.

Do not dispatch this workflow or mirror the compiler to a public website while approval is outstanding. Manual dispatch and a matching hash are **not substitutes** for independent review or protected deployment environments.

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
