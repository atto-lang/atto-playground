import { createCompiler, verifyCompilerBytes } from './compiler.js';
import { COMPILER_SHA256, COMPILER_BYTES } from './compiler-pin.js';
// The URL carries the pinned digest, so an HTTP-cached copy of an older
// compiler is never reused after a redeploy; the bytes are verified anyway.
const COMPILER_URL = new URL(`../public/atto_compiler.wasm?sha256=${COMPILER_SHA256.slice(0, 16)}`, import.meta.url);
let compilerPromise;
self.onmessage = async ({ data }) => {
  try {
    // Reject invalid/oversized untrusted requests before downloading or
    // instantiating the compiler, including UTF-16-short multibyte input.
    const kind = data?.kind ?? 'program';
    if (kind !== 'program' && kind !== 'actor') throw new Error('Unsupported compile target');
    if (typeof data?.source !== 'string') throw new TypeError('Source must be text');
    if (data.source.length > 65536 || new TextEncoder().encode(data.source).byteLength > 65536) {
      self.postMessage({ok:false, diagnostics:[{line:1,column:1,
        message:'E_SOURCE_LIMIT: source exceeds 65536 UTF-8 bytes'}]});
      return;
    }
    if (!compilerPromise) {
      compilerPromise = fetch(COMPILER_URL, { cache: 'force-cache', credentials: 'omit' })
        .then(async response => {
          if (!response.ok) throw new Error(`Compiler download failed (${response.status})`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          await verifyCompilerBytes(bytes, COMPILER_SHA256, COMPILER_BYTES);
          return createCompiler(bytes);
        });
    }
    const compiler = await compilerPromise;
    const compiled = kind === 'actor'
      ? compiler.compileActor(data.source)
      : compiler.compile(data.source);
    if (compiled.ok) {
      self.postMessage({ ok: true, wasm: compiled.wasm }, [compiled.wasm.buffer]);
    } else {
      self.postMessage({ ok: false, diagnostics: compiled.diagnostics });
    }
  } catch (error) {
    self.postMessage({ ok: false, diagnostics: [{ line: 1, column: 1, message: `E_HOST: ${error.message}` }] });
  }
};
