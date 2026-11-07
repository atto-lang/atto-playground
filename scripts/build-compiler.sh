#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p public
"${CLANG:-clang}" --target=wasm32 -std=c11 -O2 -Wall -Wextra -Werror \
  -ffreestanding -fno-builtin -nostdlib -fno-stack-protector \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--initial-memory=1048576 -Wl,--max-memory=1048576 \
  -Wl,--strip-all -o public/atto_compiler.wasm compiler/atto_compiler.c
node -e 'const fs=require("node:fs"); const w=fs.readFileSync("public/atto_compiler.wasm");if(!WebAssembly.validate(w))process.exit(1);console.log(`Compiler Wasm valid (${w.length} bytes)`)'
