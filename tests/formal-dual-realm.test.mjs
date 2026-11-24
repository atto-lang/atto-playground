import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createCompiler } from '../src/compiler.js';
import { guestImports } from '../src/guest.js';

const compilerBytes = await readFile(new URL('../public/atto_compiler.wasm', import.meta.url));
const receipt = JSON.parse(await readFile(new URL('../public/atto_compiler.receipt.json', import.meta.url), 'utf8'));
const source = await readFile(new URL('./fixtures/dual_realm_browser.atto', import.meta.url), 'utf8');
const compiler = await createCompiler(compilerBytes);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bool = value => value ? 'true' : 'false';

async function execute(formalSource, operation, inputs) {
  const program = formalSource + '\npub fnc main(): int {\n' +
    `  if ${operation}(${inputs.map(bool).join(', ')}) then\n` +
    '    return 1;\n  fi\n  return 0;\n}\n';
  const compilation = compiler.compile(program);
  assert.equal(compilation.ok, true, JSON.stringify({ operation, inputs, diagnostics: compilation.diagnostics }));
  assert.equal(WebAssembly.validate(compilation.wasm), true);
  const module = await WebAssembly.compile(compilation.wasm);
  const out = { text: '', truncated: false };
  const { imports, bind } = guestImports(module, out);
  const instance = await WebAssembly.instantiate(module, imports);
  bind(instance);
  const result = instance.exports.main();
  assert.ok(result === 0n || result === 1n, 'decision must be a canonical bool encoded as i64');
  assert.equal(out.text, '', 'authorization predicate must not produce stdout');
  return { allowed: result === 1n, guest_sha256: sha256(compilation.wasm) };
}

test('compiled Atto Wasm dual-realm predicate: exhaustive booleans and killed mutants', async () => {
  assert.equal(sha256(compilerBytes), receipt.compiler_sha256, 'compiler must match its vendored provenance');
  assert.equal(compilerBytes.length, receipt.compiler_bytes);
  assert.equal(receipt.guest_abi, 'atto.browser.guest.v2');
  assert.match(receipt.source_head, /^[a-f0-9]{40}$/);

  const operations = [
    { name: 'may_accept', reference: ([first, second, revoked]) => first && second && !revoked },
    { name: 'may_refresh', reference: ([first, second, current]) => first && second && current },
  ];
  const inputs = [];
  for (const first of [false, true]) {
    for (const second of [false, true]) {
      for (const third of [false, true]) inputs.push([first, second, third]);
    }
  }

  const outputHashes = createHash('sha256');
  let executed = 0;
  for (const operation of operations) {
    for (const input of inputs) {
      const guest = await execute(source, operation.name, input);
      assert.equal(guest.allowed, operation.reference(input), `production predicate projection mismatch for ${operation.name}(${input})`);
      outputHashes.update(guest.guest_sha256);
      executed++;
    }
  }
  assert.equal(executed, 16);

  // Deliberately unsafe source variants. All are still compiled to real Wasm
  // and run; a counterexample must distinguish every mutant from the oracle.
  const mutants = [
    { name: 'skip_second_realm', function_name: 'may_accept', match: 'first_realm_healthy, second_realm_healthy, !revoked', replacement: 'first_realm_healthy, !revoked', reference: operations[0].reference },
    { name: 'skip_revocation', function_name: 'may_accept', match: 'first_realm_healthy, second_realm_healthy, !revoked', replacement: 'first_realm_healthy, second_realm_healthy', reference: operations[0].reference },
    { name: 'skip_token_freshness', function_name: 'may_refresh', match: 'first_realm_healthy, second_realm_healthy, token_current', replacement: 'first_realm_healthy, second_realm_healthy', reference: operations[1].reference },
  ];
  const mutantWitnesses = {};
  for (const mutant of mutants) {
    assert.ok(source.includes(mutant.match), `mutation anchor missing: ${mutant.name}`);
    const unsafeSource = source.replace(mutant.match, mutant.replacement);
    let witnesses = 0;
    for (const input of inputs) {
      const guest = await execute(unsafeSource, mutant.function_name, input);
      outputHashes.update(guest.guest_sha256);
      if (guest.allowed !== mutant.reference(input)) witnesses++;
    }
    assert.ok(witnesses > 0, `unsafe mutant unexpectedly passed every case: ${mutant.name}`);
    mutantWitnesses[mutant.name] = witnesses;
  }

  const evidence = {
    schema: 'atto.formal.dual_realm.compiled_wasm.v1',
    status: 'passed',
    scope: 'M0 source projection executed as Wasm guest in Node.js, not exact formal module, native backend or production JWT',
    compiler_source_repository: receipt.source_repository,
    compiler_source_head: receipt.source_head,
    compiler_sha256: receipt.compiler_sha256,
    guest_abi: receipt.guest_abi,
    fixture_sha256: sha256(source),
    executable_cases: executed,
    executed_mutant_cases: inputs.length * mutants.length,
    mutant_witnesses: mutantWitnesses,
    guest_set_sha256: outputHashes.digest('hex'),
    compiled_attolang_wasm: 'EXECUTED',
    production_authz_replay: 'NOT_IN_THIS_LANE',
    java: 'NOT_EXECUTED',
    llvm: 'NOT_EXECUTED',
    forge: 'NOT_EXECUTED',
    dotnet: 'NOT_EXECUTED',
  };
  const outputDir = new URL('../target/formal/', import.meta.url);
  await mkdir(outputDir, { recursive: true });
  await writeFile(new URL('dual-realm-wasm-receipt.json', outputDir), JSON.stringify(evidence, null, 2) + '\n');
  console.log('AttoLang compiled Wasm dual-realm receipt: ' + JSON.stringify(evidence));
});
