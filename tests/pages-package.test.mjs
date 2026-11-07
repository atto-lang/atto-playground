import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { packagePages, PAGES_ASSETS } from '../scripts/package-pages.mjs';

const blankWasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'atto-pages-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of PAGES_ASSETS) {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, name.endsWith('.wasm') ? blankWasm : 'safe ' + name);
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
  assert.deepEqual((await readdir(join(root, '_site'))).sort(), ['docs', 'index.html', 'public', 'release-manifest.json', 'src', 'styles.css'].sort());
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
  await writeFile(join(root, 'public/atto_compiler.wasm'), blankWasm);
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
