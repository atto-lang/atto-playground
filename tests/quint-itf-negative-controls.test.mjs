import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { decodeItfBundle, verifyRawItfTrace } from './helpers/quint-itf-validation.mjs';

const sha256 = text => createHash('sha256').update(text).digest('hex');
const projection = JSON.parse(await readFile(new URL('./fixtures/quint-dual-realm-state-projection.json', import.meta.url), 'utf8'));
const bundle = await readFile(new URL('./fixtures/quint-dual-realm-raw-itf.deflate.b64', import.meta.url), 'utf8');
const raw = decodeItfBundle(bundle);
const expectedDigests = [
  '0688f061ed190fb616cbca201c3f97018af70a0f43178fdb3a2d157228eda1a7',
  '15b386b77a1f5e0809b882fcc59632ce4a484508528bea080fe0085a49bfdf1d',
  '2f550a98f6977c5b43a1de1e32534d8d6e3342cd39b21aed0ee700ffdd54df3b',
  'e80cc53565f9c92ad9ee8a0e4e8f7bb66eb1969db149fe9949305079e2063a80',
];

function mutateTrace(mutator) {
  const object = JSON.parse(raw[0]);
  mutator(object);
  const changed = JSON.stringify(object);
  return [changed, { ...projection.traces[0], raw_itf_sha256: sha256(changed) }];
}

test('source-authenticated raw ITF bytes must match independent exact trace digests', () => {
  assert.equal(sha256(bundle), '18ade57a27d72799b9ad85b6a9488d0ee197d1d4b21581af7a93ee4f3f813a13');
  assert.deepEqual(projection.traces.map(t => t.raw_itf_sha256), expectedDigests);
  for (let i = 0; i < raw.length; i++) {
    assert.equal(sha256(raw[i]), expectedDigests[i]);
    assert.equal(verifyRawItfTrace(raw[i], projection.traces[i], i), projection.traces[i].states);
  }
});

test('malformed or excessive compressed ITF inputs are rejected before model replay', () => {
  assert.throws(() => decodeItfBundle(''), /size budget/);
  assert.throws(() => decodeItfBundle('%%%='), /base64/);
  assert.throws(() => decodeItfBundle('A'.repeat(17000)), /size budget/);
  assert.throws(() => decodeItfBundle(deflateSync('[]').toString('base64')), /exactly four/);
  assert.throws(() => decodeItfBundle(deflateSync('not json').toString('base64')), SyntaxError);
  assert.throws(() => decodeItfBundle(deflateSync('A'.repeat(256 * 1024)).toString('base64')), /output length|larger than|exceeds|ERR_BUFFER_TOO_LARGE/i);
});

test('an ITF body whose digest no longer matches the producer is rejected', () => {
  assert.throws(() => verifyRawItfTrace(raw[0] + ' ', projection.traces[0], 0), /digest differs/);
});

test('even with an attacker-updated digest, a forged accepted state is rejected', () => {
  const [content, entry] = mutateTrace(x => { x.states[1].accepted = true; });
  assert.throws(() => verifyRawItfTrace(content, entry, 0), /accepted requires/);
});

test('even with an updated digest, an impossible model transition is rejected', () => {
  const [content, entry] = mutateTrace(x => { x.states[1].realm_b = true; });
  assert.throws(() => verifyRawItfTrace(content, entry, 0), /impossible Quint transition/);
});

test('even with an updated digest, corrupted metadata, unknown fields and types are rejected', () => {
  const mutations = [
    x => { x['#meta'].source = 'formal/attacker.qnt'; },
    x => { x.states[1]['#meta'].index = 0; },
    x => { x.states[1].realm_a = 'true'; },
    x => { x.states[1].untrusted = false; },
    x => { x.vars = ['realm_a', 'realm_b', 'accepted']; },
    x => { x.states.pop(); },
    x => { x.states[0]['mbt::actionTaken'] = ''; },
  ];
  for (const change of mutations) {
    const [content, entry] = mutateTrace(change);
    assert.throws(() => verifyRawItfTrace(content, entry, 0), 'mutation must be rejected');
  }
});

test('altered projection is rejected even when the raw ITF is authentic', () => {
  assert.throws(() => verifyRawItfTrace(raw[0], { ...projection.traces[0], states: '0'.repeat(21) }, 0), /does not match/);
});
