import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { guestImports } from '../src/guest.js';
import { decodeItfBundle, unpackBooleanState, allowedModelTransition, verifyRawItfTrace } from './helpers/quint-itf-validation.mjs';

const projection = JSON.parse(await readFile(new URL('./fixtures/quint-dual-realm-state-projection.json', import.meta.url), 'utf8'));
const projectionBytes = await readFile(new URL('./fixtures/quint-dual-realm-state-projection.json', import.meta.url));
const rawTraceBundle = await readFile(new URL('./fixtures/quint-dual-realm-raw-itf.deflate.b64', import.meta.url), 'utf8');
const rawTraceTexts = decodeItfBundle(rawTraceBundle);
const source = await readFile(new URL('./fixtures/dual_realm_browser.atto', import.meta.url), 'utf8');
const compilerBytes = await readFile(new URL('../public/atto_compiler.wasm', import.meta.url));
const compilerReceipt = JSON.parse(await readFile(new URL('../public/atto_compiler.receipt.json', import.meta.url), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('genuine Quint-generated states one-way refine compiled Atto guest admission', async () => {
  assert.equal(projection.schema, 'shared-auth.quint-itf-state-projection.v1');
  assert.equal(projection.producer.repository, 'shared-auth/shared-auth-formal');
  assert.equal(projection.producer.source_head, '4b54df546d6f2385c6de081a7b3892c19a1fc99e');
  assert.equal(projection.producer.quint_model_sha256, 'cb41b05c0a2b90489d56e270ecf197839546aa59315cdbcc7acb91b5dc03c869');
  assert.equal(projection.producer.workflow_run_id, 42394560514);
  assert.equal(projection.producer.artifact_id, 13582817373);
  assert.equal(projection.producer.toolchain, 'Quint 0.32.0 (typescript simulator)');
  assert.equal(projection.producer.status, 'EXECUTED_QUINT_SIMULATION');
  assert.equal(projection.producer.artifact_zip_sha256, '2395238077710fef3584e0fdd7417a10afb457ed5a199a8e3d6df2159785d64d');
  assert.equal(projection.traces.length, 4);
  assert.equal(rawTraceTexts.length, projection.traces.length, 'all original ITF traces must be bundled');
  assert.equal(sha256(compilerBytes), compilerReceipt.compiler_sha256);
  assert.equal(compilerBytes.length, compilerReceipt.compiler_bytes);
  assert.equal(compilerReceipt.guest_abi, 'atto.browser.guest.v1');

  const compiler = await createCompiler(compilerBytes);
  const cached = new Map();
  const guestHashes = createHash('sha256');

  async function mayAcceptInGuest(a, b) {
    const key = `${Number(a)}${Number(b)}`;
    if (cached.has(key)) return cached.get(key);
    const program = source + `\npub fnc main(): int {\n  if may_accept(${a}, ${b}, false) then\n    return 1;\n  fi\n  return 0;\n}\n`;
    const compiled = compiler.compile(program);
    assert.equal(compiled.ok, true, JSON.stringify({ key, diagnostics: compiled.diagnostics }));
    assert.equal(WebAssembly.validate(compiled.wasm), true);
    const module = await WebAssembly.compile(compiled.wasm);
    const out = { text: '', truncated: false };
    const { imports, bind } = guestImports(module, out);
    const instance = await WebAssembly.instantiate(module, imports);
    bind(instance);
    const result = instance.exports.main();
    assert.ok(result === 0n || result === 1n, 'guest must return canonical bool integer');
    assert.equal(out.text, '', 'admission oracle must not print');
    guestHashes.update(sha256(compiled.wasm));
    cached.set(key, result === 1n);
    return result === 1n;
  }

  let states = 0, transitions = 0, modelAccepted = 0, deniedByBothRealms = 0;
  const originalHashes = [];
  for (let index = 0; index < projection.traces.length; index++) {
    const trace = projection.traces[index];
    assert.equal(trace.itf, `trace_${index}.itf.json`);
    const rawText = rawTraceTexts[index];
    verifyRawItfTrace(rawText, trace, index);
    originalHashes.push(trace.raw_itf_sha256);
    let prev = null;
    for (const char of trace.states) {
      const state = unpackBooleanState(char);
      if (prev === null) {
        assert.deepEqual(state, { a: false, b: false, accepted: false }, 'model init');
      } else {
        assert.ok(allowedModelTransition(prev, state), `non-model transition at trace ${index}, step ${states}`);
        transitions++;
      }
      assert.ok(!state.accepted || (state.a && state.b), 'Quint safety invariant');
      const guest = await mayAcceptInGuest(state.a, state.b);
      assert.equal(guest, state.a && state.b, 'guest must compute both-realms predicate');
      if (state.accepted) {
        modelAccepted++;
        assert.equal(guest, true, 'model-accepted state must be admitted by compiled Atto guest');
      }
      if (!state.a || !state.b) {
        deniedByBothRealms++;
        assert.equal(guest, false, 'an unready realm must be refused');
      }
      prev = state;
      states++;
    }
  }
  assert.equal(states, 84);
  assert.equal(transitions, 80);
  assert.ok(modelAccepted > 0, 'trace set must witness an accepted state');
  assert.ok(deniedByBothRealms > 0, 'trace set must witness an unready-realm refusal');
  assert.ok(cached.size >= 2, 'at least two distinct guest inputs must execute');

  const evidence = {
    schema: 'atto.formal.quint-itf-wasm-one-way-refinement.v1',
    scope: 'Recorded Quint 0.32.0 ITF Boolean-state projection -> M0 compiled Wasm predicate; accepted implies guest may_accept',
    status: 'passed',
    replay_kind: 'bounded_one_way_predicate_refinement',
    input_projection_sha256: sha256(projectionBytes),
    original_itf_bundle_sha256: sha256(rawTraceBundle),
    original_itf_bytes_verified: true,
    quint_model_sha256: projection.producer.quint_model_sha256,
    quint_source_head: projection.producer.source_head,
    quint_run_id: projection.producer.workflow_run_id,
    quint_artifact_id: projection.producer.artifact_id,
    quint_zip_digest: projection.producer.artifact_zip_sha256,
    raw_trace_digests: originalHashes,
    atto_fixture_sha256: sha256(source),
    compiler_source_head: compilerReceipt.source_head,
    compiler_sha256: compilerReceipt.compiler_sha256,
    replayed_traces: projection.traces.length,
    replayed_states: states,
    witnessed_transitions: transitions,
    accepted_states: modelAccepted,
    refused_unready_states: deniedByBothRealms,
    unique_compiled_guest_inputs: cached.size,
    guest_artifact_set_sha256: guestHashes.digest('hex'),
    compiled_wasm_guest: 'EXECUTED',
    exact_formal_attolang_module: 'NOT_EXECUTED',
    java: 'NOT_EXECUTED',
    llvm: 'NOT_EXECUTED',
    forge: 'NOT_EXECUTED',
    dotnet: 'NOT_EXECUTED',
    production_jwt_refinement: false
  };
  const dir = new URL('../target/formal/', import.meta.url);
  await mkdir(dir, { recursive: true });
  await writeFile(new URL('dual-realm-quint-replay-receipt.json', dir), JSON.stringify(evidence, null, 2) + '\n');
  console.log('Quint -> compiled Atto Wasm replay evidence: ' + JSON.stringify(evidence));
});
