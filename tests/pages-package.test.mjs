import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, posix } from 'node:path';
import { packagePages, PAGES_ASSETS } from '../scripts/package-pages.mjs';

const releaseWasm = await readFile(new URL('../public/atto_compiler.wasm', import.meta.url));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atto-pages-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of PAGES_ASSETS) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    const checked = ['public/atto_compiler.wasm','public/atto_compiler.receipt.json','src/compiler-pin.js',
      'public/oreslang_format.wasm','public/oreslang_format.receipt.json','src/formatter-pin.js'].includes(name);
    await writeFile(path, checked ? await readFile(new URL('../'+name, import.meta.url)) : 'safe ' + name);
  }
  return root;
}

test('allowlist excludes unrelated source, tests, dotfiles and unreviewed assets', async t => {
  const root = await fixture(t);
  await mkdir(join(root, '.github'));
  await writeFile(join(root, '.github/private-key'), 'do not publish');
  await writeFile(join(root, 'src/undeclared.js'), 'secret');
  const sha = 'f'.repeat(40);
  const manifest = await packagePages({ root, destination: '_site', sourceSha: sha });
  assert.equal(manifest.source_commit, sha);
  assert.deepEqual(Object.keys(manifest.assets), PAGES_ASSETS);
  assert.deepEqual((await readdir(join(root, '_site'))).sort(), ['docs', 'examples', 'index.html', 'public', 'release-manifest.json', 'src', 'styles.css'].sort());
  const recorded = JSON.parse(await readFile(join(root, '_site/release-manifest.json'), 'utf8'));
  assert.deepEqual(recorded, manifest);
  for (const name of PAGES_ASSETS) {
    const bytes = await readFile(join(root, '_site', name));
    assert.equal(manifest.assets[name].sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  await assert.rejects(readFile(join(root, '_site/src/undeclared.js')), /ENOENT/);
  await assert.rejects(readFile(join(root, '_site/.github/private-key')), /ENOENT/);
});

test('rejects direct symlinks before creating the public directory', async t => {
  const root = await fixture(t);
  await rm(join(root, 'src/app.js'));
  await symlink('worker-task.js', join(root, 'src/app.js'));
  await assert.rejects(packagePages({ root }), /Symbolic links/);
  await assert.rejects(readdir(join(root, '_site')), /ENOENT/);
});

test('rejects symlinked ancestor directories even if targets are valid', async t => {
  const root = await fixture(t);
  await rm(join(root, 'docs'), { recursive: true });
  await symlink('src', join(root, 'docs'), 'dir');
  await assert.rejects(packagePages({ root }), /Symbolic links/);
});

test('refuses invalid compiler Wasm, empty/oversized assets and bad commit metadata', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'public/atto_compiler.wasm'), 'invalid');
  await assert.rejects(packagePages({ root }), /Invalid compiler Wasm/);
  await writeFile(join(root, 'public/atto_compiler.wasm'), releaseWasm);
  await writeFile(join(root, 'styles.css'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(packagePages({ root }), /Invalid published asset size/);
  await writeFile(join(root, 'styles.css'), 'safe');
  await assert.rejects(packagePages({ root, sourceSha: 'not-a-commit' }), /Invalid source commit SHA/);
});

test('cannot package outside project tree or destroy source root', async t => {
  const root = await fixture(t);
  for (const destination of [root, '../escape', 'src', 'public', 'docs', '.github']) {
    await assert.rejects(packagePages({ root, destination }), /Only _site/, destination);
  }
  assert.ok((await readFile(join(root, 'index.html'))).length > 0);
});

test('fails closed when compiler receipt/pin disagree or approval is absent', async t => {
  const root = await fixture(t);
  await assert.rejects(packagePages({ root, approvedCompilerSha256: 'f'.repeat(64) }), /release lacks matching public-disclosure approval/);
  await packagePages({ root, approvedCompilerSha256: JSON.parse(await readFile(join(root, 'public/atto_compiler.receipt.json'), 'utf8')).compiler_sha256 });
  const receiptPath = join(root,'public/atto_compiler.receipt.json');
  const receipt = JSON.parse(await readFile(receiptPath,'utf8'));
  receipt.compiler_sha256 = '0'.repeat(64);
  await writeFile(receiptPath, JSON.stringify(receipt));
  await assert.rejects(packagePages({ root }), /Compiler receipt, pinned digest or byte length does not match/);
});

test('Pages staging path cannot be a symlink', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'malicious'));
  await symlink('malicious', join(root, '_site'));
  await assert.rejects(packagePages({ root }), /Pages staging directory cannot be a symlink/);
});


test('forged formatter receipt or Wasm is rejected before staging', async t => {
  const root = await fixture(t);
  const receiptPath=join(root,'public/oreslang_format.receipt.json');
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  receipt.wasm_sha256='0'.repeat(64);
  await writeFile(receiptPath,JSON.stringify(receipt));
  await assert.rejects(packagePages({root}),/Formatter provenance, length or SHA-256 mismatch/);
  await writeFile(receiptPath,await readFile(new URL('../public/oreslang_format.receipt.json',import.meta.url)));
  await writeFile(join(root,'public/oreslang_format.wasm'),'bad-wasm');
  await assert.rejects(packagePages({root}),/Invalid compiler Wasm/);
  await assert.rejects(readdir(join(root,'_site')),/ENOENT/);
});


test('every local browser module import belongs to the published asset allowlist', async () => {
  const assets = new Set(PAGES_ASSETS);
  for (const name of PAGES_ASSETS.filter(p => p.endsWith('.js'))) {
    const source = await readFile(new URL('../' + name, import.meta.url), 'utf8');
    // Static imports, re-exports, side-effect imports and literal dynamic
    // imports must resolve to published files. The browser E2E remains the
    // authoritative check for nonliteral runtime URL construction.
    const dependencies = source.matchAll(/\b(?:from\s*|import\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\1/g);
    for (const match of dependencies) {
      const target = posix.normalize(posix.join(posix.dirname(name), match[2].split('?')[0]));
      assert.ok(assets.has(target), name + ' depends on omitted Pages asset ' + target);
    }
  }
  for (const essential of [
    'src/actor-abi-version.js',
    'src/tenant-actor-host.js',
    'src/local-actor-registry.js',
    'src/wasm-memory-admission.js',
  ]) {
    assert.ok(assets.has(essential), essential + ' must ship with the actor runtime');
  }
});
