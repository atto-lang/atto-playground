import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const workflow = readFileSync(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
const docs = readFileSync(new URL('../docs/DEPLOY.md', import.meta.url), 'utf8');

test('Pages cannot publish automatically on pushes or PRs', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:\s*$/m);
  assert.doesNotMatch(workflow, /^\s+pull_request:\s*$/m);
  assert.match(workflow, /confirm_public_disclosure == 'yes'/);
});
test('public binary must match independently set administrator digest', () => {
  assert.match(workflow, /vars\.ATTO_PUBLIC_COMPILER_SHA256/);
  assert.match(workflow, /REQUESTED_SHA256.*inputs\.expected_compiler_sha256/);
  assert.match(workflow, /test "\$REQUESTED_SHA256" = "\$APPROVED_SHA256"/);
  assert.match(workflow, /test "\$ACTUAL_SHA256" = "\$APPROVED_SHA256"/);
  assert.match(workflow, /APPROVED_SHA256.*-eq 64/);
  assert.match(workflow, /ref: main/);
  assert.match(workflow, /cmp public\/atto_compiler\.wasm _site\/public\/atto_compiler\.wasm/);
  assert.match(workflow, /npm run verify/);
});
test('deployment permissions stay least-privilege and independent review is documented', () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /name: github-pages/);
  assert.match(docs, /required reviewers/);
  assert.match(docs, /ATTO_PUBLIC_COMPILER_SHA256/);
});
