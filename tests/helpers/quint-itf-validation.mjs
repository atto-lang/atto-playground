import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

// These caps apply before JSON parsing or guest compilation. A source-owned
// fixture must not silently become an unbounded decompression/parser input.
export const TRACE_COUNT = 4;
export const STATES_PER_TRACE = 21;
const MAX_BASE64_BYTES = 16 * 1024;
const MAX_COMPRESSED_BYTES = 12 * 1024;
const MAX_DECOMPRESSED_BYTES = 128 * 1024;
const MAX_TRACE_BYTES = 16 * 1024;
const STATE_KEYS = ['#meta', 'accepted', 'mbt::actionTaken', 'mbt::nondetPicks', 'realm_a', 'realm_b'].sort();
const VAR_NAMES = ['realm_a', 'realm_b', 'accepted', 'mbt::actionTaken', 'mbt::nondetPicks'];
const SHA256 = value => createHash('sha256').update(value).digest('hex');

export function decodeItfBundle(base64) {
  assert.equal(typeof base64, 'string', 'ITF fixture must be base64 text');
  const clean = base64.trim();
  assert.ok(clean.length > 0 && clean.length <= MAX_BASE64_BYTES, 'encoded ITF bundle exceeds size budget');
  assert.ok(clean.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(clean), 'noncanonical base64 ITF bundle');
  const compressed = Buffer.from(clean, 'base64');
  assert.ok(compressed.length <= MAX_COMPRESSED_BYTES, 'compressed ITF bundle exceeds size budget');
  assert.equal(compressed.toString('base64'), clean, 'noncanonical base64 encoding');
  const output = inflateSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES });
  assert.ok(output.length > 0 && output.length <= MAX_DECOMPRESSED_BYTES, 'expanded ITF bundle exceeds size budget');
  const traces = JSON.parse(output.toString('utf8'));
  assert.ok(Array.isArray(traces) && traces.length === TRACE_COUNT, 'expected exactly four authentic ITF documents');
  for (const trace of traces) {
    assert.equal(typeof trace, 'string', 'raw ITF entries must be strings');
    assert.ok(Buffer.byteLength(trace, 'utf8') <= MAX_TRACE_BYTES, 'individual ITF trace exceeds size budget');
  }
  return traces;
}

export function unpackBooleanState(bits) {
  assert.match(bits, /^[0-7]$/, 'projected states must be three Boolean bits');
  const value = Number(bits);
  return { a: Boolean(value & 4), b: Boolean(value & 2), accepted: Boolean(value & 1) };
}

export function allowedModelTransition(previous, next) {
  const sameRealms = previous.a === next.a && previous.b === next.b;
  const sameAccepted = previous.accepted === next.accepted;
  const stutter = sameRealms && sameAccepted;
  const enableA = !previous.a && next.a && next.b === previous.b && sameAccepted;
  const enableB = !previous.b && next.b && next.a === previous.a && sameAccepted;
  const accept = sameRealms && !previous.accepted && next.accepted && previous.a && previous.b;
  const clear = sameRealms && previous.accepted && !next.accepted;
  return stutter || enableA || enableB || accept || clear;
}

// Verify original bytes, trace structure, actions and transitions BEFORE
// projecting or running any generated guest code. This is intentionally an
// independent record of the simple Quint state machine, not an interpreter.
export function verifyRawItfTrace(rawText, projection, traceIndex) {
  assert.equal(typeof rawText, 'string');
  assert.equal(SHA256(rawText), projection.raw_itf_sha256, 'raw ITF digest differs from producer receipt');
  assert.equal(projection.itf, `trace_${traceIndex}.itf.json`, 'unexpected trace identity');
  assert.equal(typeof projection.states, 'string');
  assert.match(projection.states, /^[0-7]{21}$/, 'projected states must contain exactly 21 Boolean states');

  const trace = JSON.parse(rawText);
  assert.ok(trace && typeof trace === 'object' && !Array.isArray(trace));
  assert.deepEqual(Object.keys(trace).sort(), ['#meta', 'states', 'vars']);
  assert.equal(trace['#meta']?.format, 'ITF');
  assert.equal(trace['#meta']?.source, 'formal/dual_realm.qnt');
  assert.equal(trace['#meta']?.status, 'ok');
  assert.deepEqual(trace.vars, VAR_NAMES, 'unexpected variables in the authentic model output');
  assert.ok(Array.isArray(trace.states) && trace.states.length === STATES_PER_TRACE);
  let bits = '';
  let previous = null;
  for (let index = 0; index < trace.states.length; index++) {
    const row = trace.states[index];
    assert.ok(row && typeof row === 'object' && !Array.isArray(row));
    assert.deepEqual(Object.keys(row).sort(), STATE_KEYS, 'malformed or extra ITF state fields');
    assert.deepEqual(row['#meta'], { index }, 'missing, reordered or duplicated state index');
    assert.ok(row['mbt::nondetPicks'] && typeof row['mbt::nondetPicks'] === 'object' && !Array.isArray(row['mbt::nondetPicks']));
    assert.equal(typeof row['mbt::actionTaken'], 'string');
    if (index === 0) assert.equal(row['mbt::actionTaken'], 'init');
    for (const name of ['realm_a', 'realm_b', 'accepted']) {
      assert.equal(typeof row[name], 'boolean', 'non-Boolean ITF state field: ' + name);
    }
    const state = { a: row.realm_a, b: row.realm_b, accepted: row.accepted };
    assert.ok(!state.accepted || (state.a && state.b), 'accepted requires both healthy realms');
    if (previous === null) assert.deepEqual(state, { a: false, b: false, accepted: false }, 'initial state must be all false');
    else assert.ok(allowedModelTransition(previous, state), `impossible Quint transition at index ${index}`);
    bits += String(4 * Number(state.a) + 2 * Number(state.b) + Number(state.accepted));
    previous = state;
  }
  assert.equal(bits, projection.states, 'Boolean projection does not match independently validated raw states');
  return bits;
}
