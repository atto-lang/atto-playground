/** Static release gate: only these reviewed browser assets may enter a Pages artifact. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPILER_SHA256, COMPILER_BYTES } from '../src/compiler-pin.js';

export const PAGES_ASSETS = Object.freeze([
  'index.html',
  'styles.css',
  'src/app.js',
  'src/compiler.js',
  'src/compiler-worker.js',
  'src/runner-worker.js',
  'src/guest.js',
  'src/worker-task.js',
  'src/compiler-pin.js',
  'public/atto_compiler.wasm',
  'public/atto_compiler.receipt.json',
  'docs/COMPILER_CONTRACT.md',
  'examples/conditions.atto',
  'examples/error.atto',
  'examples/fib.atto',
  'examples/hello.atto',
  'examples/overflow.atto',
  'examples/primes.atto',
]);

async function checkedFile(root, name) {
  let current = root;
  const parts = name.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Symbolic links cannot be published: ' + name);
    if (index < parts.length - 1 && !info.isDirectory()) throw new Error('Expected directory: ' + current);
    if (index === parts.length - 1 && !info.isFile()) throw new Error('Expected regular file: ' + name);
  }
  const bytes = await readFile(current);
  if (!bytes.length || bytes.length > 1024 * 1024) throw new Error('Invalid published asset size: ' + name);
  return bytes;
}

export async function packagePages({
  root = fileURLToPath(new URL('..', import.meta.url)),
  destination = '_site',
  sourceSha = null,
  approvedCompilerSha256 = null
} = {}) {
  const projectRoot = resolve(root);
  const target = resolve(projectRoot, destination);
  // Never let a caller point the cleanup operation at a source directory.
  if (target !== resolve(projectRoot, '_site')) throw new Error('Only _site is an allowed Pages staging destination');
  if (sourceSha !== null && !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('Invalid source commit SHA');

  // Read and validate everything before removing or writing the destination.
  const files = [];
  for (const name of PAGES_ASSETS) {
    const bytes = await checkedFile(projectRoot, name);
    if (name.endsWith('.wasm')) {
      if (!WebAssembly.validate(bytes)) throw new Error('Invalid compiler Wasm in Pages artifact');
      const mod = await WebAssembly.compile(bytes);
      if (WebAssembly.Module.imports(mod).length) throw new Error('Compiler imports are prohibited in Pages artifact');
    }
    files.push({ name, bytes });
  }
  const compiler = files.find(x => x.name === 'public/atto_compiler.wasm').bytes;
  const receipt = JSON.parse(files.find(x => x.name === 'public/atto_compiler.receipt.json').bytes.toString('utf8'));
  if (receipt.schema !== 'atto.browser.compiler.vendor.v1' ||
      receipt.compiler_sha256 !== COMPILER_SHA256 ||
      receipt.compiler_bytes !== COMPILER_BYTES ||
      compiler.length !== COMPILER_BYTES ||
      createHash('sha256').update(compiler).digest('hex') !== receipt.compiler_sha256) {
    throw new Error('Compiler receipt, pinned digest or byte length does not match');
  }
  if (approvedCompilerSha256 !== null && (
      !/^[a-f0-9]{64}$/.test(approvedCompilerSha256) ||
      approvedCompilerSha256 !== receipt.compiler_sha256)) {
    throw new Error('Compiler release lacks matching public-disclosure approval');
  }
  const targetEntry = await lstat(target).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (targetEntry?.isSymbolicLink()) throw new Error('Pages staging directory cannot be a symlink');
    await rm(target, { recursive: true, force: true });
  const assets = {};
  for (const { name, bytes } of files) {
    const path = join(target, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
    assets[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const manifest = { schema: 1, source_commit: sourceSha, assets };
  await writeFile(join(target, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = await packagePages({
    destination: process.argv[2] || '_site',
    sourceSha: process.env.SOURCE_COMMIT || null,
    approvedCompilerSha256: process.env.APPROVED_COMPILER_SHA256 || null
  });
  console.log('PASS: ' + Object.keys(manifest.assets).length + ' explicitly allowlisted Pages assets; compiler SHA256 ' +
    manifest.assets['public/atto_compiler.wasm'].sha256);
}
