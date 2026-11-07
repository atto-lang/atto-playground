# Playground compiler contract (experimental M0)

This is a **real Atto source-to-Wasm compiler hosted inside Wasm**, not a JS evaluator or a claim of full AttoLang compiler parity. Only the explicitly listed scalar subset is admitted. The frontend is a small freestanding C bootstrap; promotion to the canonical portable Atto frontend is a separate tracked dependency. There is no LLVM toolchain in the browser and no server compiling user source.

## Accepted grammar

```ebnf
program = "fnc", "main", "(", ")", "->", "int", "{", { declaration | assignment }, "return", expression, ";", "}" ;
declaration = [ "const" | "let" | "mut" ], [ "int" ], identifier, "=", expression, ";" ;
assignment = identifier, "=", expression, ";" ;
expression = term, { ("+"|"-"), term } ;
term = atom, { ("*"|"/"), atom } ;
atom = integer | identifier | "(", expression, ")" | "-", atom ;
```

An unprefixed declaration must begin with `int`; `const x`, `const int x`, `int x` are immutable aliases. `let`/`mut` makes the binding reassignable. One `main` entrypoint, zero parameters, scalar signed i32 return, at most 64 locals and at most 128 nested expression levels. Initializers cannot reference the variable being declared. Division uses signed truncating Wasm `i32.div_s`; division by zero traps. Arithmetic overflow currently uses Wasm i32 wrapping, which is an explicit **experimental playground subset choice**, not a claim of canonical AttoLang overflow semantics. Numbers are restricted to 0…2147483647 before unary negation. There is no automatic type coercion.

No imports, arbitrary functions, floats, strings, actors, allocation, loops, file/network access, GPU, or general control flow. Unsupported syntax fails closed. The compiler module has no imports and a bounded 1 MiB memory. Generated guest modules contain only `main: () -> i32`, no imports, no memory, and no start section.

## Host ABI

`atto_compiler.wasm` exports `memory`, `input_ptr`, `input_capacity`, `compile(length)`, `result_ptr`, `result_length`, `error_ptr`, `error_line_number`, and `error_column_number`. `compile` returns zero on success; nonzero on error with `result_length=0`. Code is copied out of compiler linear memory before the worker is terminated.

This is not production-ready sandboxing or whole-language coverage. All user code is untrusted; do not enable imports without an explicit capability policy. Cross-repository integration must pin compiler source SHA, artifact digest, executed tests, and independent review before claims of backend parity.


## Static release artifact boundary

`scripts/package-pages.mjs` is the **only** approved build path for the GitHub Pages artifact. It copies precisely the explicit HTML, CSS, JS, compiler-Wasm and public contract files, checks every parent component against symlinks, verifies the shipped compiler is valid import-free WebAssembly, and writes `release-manifest.json` containing source SHA and per-file SHA-256. It does not publish `compiler/`, `tests/`, `.github/`, or arbitrary new paths. Browser E2E runs against the staged output, not only the source checkout.

Pages deployment is deliberately restricted to a `push` on `main`; workflow dispatch from an unreviewed branch is not a release path. Repository branch protection, independent approval, hosting eligibility, deployment environment protection and public HTTPS checks remain **administrative release gates** and are not satisfied by this workflow alone.
