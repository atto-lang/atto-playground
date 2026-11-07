# Deploying AttoLang Playground

The build is **static**: browsers download the compiler Wasm and generate/run guest Wasm locally, without sending source to a compilation server.

## GitHub Pages project site

This repository includes `.github/workflows/pages.yml`. Enable **Settings → Pages → Build and deployment → GitHub Actions** (subject to the organization's private-repository Pages eligibility). After an independently reviewed merge into `main`, the workflow builds and tests the actual compiler and deploys the site.

Expected default project URL after successful deployment (not verified live yet):

`https://atto-lang.github.io/atto-playground/`

The workflow regenerates the compiler from checked-in C source before publication. Do not treat the committed `public/atto_compiler.wasm` binary alone as reproducible release evidence across different unpinned Clang distributions. Verify the build's toolchain version, exact source head, checked-out tree, executed test steps, and resulting Wasm SHA-256.

## Custom subdomain

If the organization controls an AttoLang domain, map an approved `play.<domain>` custom hostname to the GitHub Pages project deployment, or host the same static assets with a CDN supporting such hostnames. Set DNS only after verifying domain ownership and the GitHub Pages custom domain configuration. No domain or DNS is configured by this repository.

For Cloudflare Pages, build command `npm run verify`, output directory `_site` after running the same packaging commands as the Pages workflow. Serve `.wasm` with `application/wasm` and strong cache controls for versioned assets. The HTTP CSP should enforce `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. Add security headers `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `frame-ancestors 'none'` in HTTP headers (not via CSP meta).

## Integration

Add a `Playground` navigation item in the AttoLang language website that points at the **verified live URL**. The `atto-co` company site can link to that same URL. Do not imply that a custom domain is live before DNS and deployment are independently checked.

## Security

This M0 guest has no imports or memory and returns i32. Compilation and execution are isolated into disposable browser workers with a bounded time budget. Browser workers are not OS-level isolation. Do not expose arbitrary host imports to user Wasm, and do not claim full-language parity or a production-grade sandbox based on M0 tests alone.
