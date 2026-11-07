import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { COMPILER_SHA256 } from '../src/compiler-pin.js';
import { PAGES_ASSETS } from '../scripts/package-pages.mjs';

const candidate = JSON.parse(await readFile(new URL('../release-candidates/rust-wasm-new-class-2026-11-07.json', import.meta.url), 'utf8'));
const script = new URL('../scripts/verify-private-candidate.mjs', import.meta.url).pathname;

test('private promotion harness never claims candidate execution without private artifact', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 4000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NOT_EXECUTED: provide external private compiler Wasm and artifact receipt/);
  assert.doesNotMatch(result.stdout, /PASS PRIVATE|PUBLIC_RELEASE=NOT_AUTHORIZED/);
});

test('review-only candidate is not the pinned public compiler', () => {
  assert.equal(candidate.schema, 'atto.playground.compiler.candidate.v1');
  assert.equal(candidate.publish_authorized, false);
  assert.match(candidate.source_head, /^[0-9a-f]{40}$/);
  assert.match(candidate.source_tree, /^[0-9a-f]{40}$/);
  assert.match(candidate.compiler_sha256, /^[0-9a-f]{64}$/);
  assert.notEqual(candidate.compiler_sha256, COMPILER_SHA256,
    'promotion requires a new independent review, pin and release gate');
});

test('private candidate script and metadata cannot enter the Pages allowlist', () => {
  assert.equal(PAGES_ASSETS.some(name => name.startsWith('release-candidates/')), false);
  assert.equal(PAGES_ASSETS.some(name => name.startsWith('scripts/')), false);
  assert.equal(PAGES_ASSETS.some(name => name.startsWith('tests/')), false);
});
