/** Static release gate: only these reviewed browser assets may enter a Pages artifact. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAGES_ASSETS = Object.freeze([
  'index.html',
  'styles.css',
  'src/app.js',
  'src/compiler.js',
  'src/compiler-worker.js',
  'src/runner-worker.js',
  'src/worker-task.js',
  'public/atto_compiler.wasm',
  'docs/COMPILER_CONTRACT.md'
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
  sourceSha = null
} = {}) {
  const projectRoot = resolve(root);
  const target = resolve(projectRoot, destination);
  if (!target.startsWith(projectRoot + sep)) throw new Error('Refusing destination outside source tree');
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
    sourceSha: process.env.SOURCE_COMMIT || null
  });
  console.log('PASS: ' + Object.keys(manifest.assets).length + ' explicitly allowlisted Pages assets; compiler SHA256 ' +
    manifest.assets['public/atto_compiler.wasm'].sha256);
}
