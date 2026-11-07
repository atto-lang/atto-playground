/** Private, read-only, compiler-backed promotion rehearsal; never publishes bytes.
 * Usage: node scripts/verify-private-candidate.mjs <candidate.wasm> <receipt.json>
 * Both files come from the exact-head, privately approved-for-testing CI artifact.
 * NO BYTES OR APPROVAL are inferred from the existing public compiler pin.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createCompiler, verifyCompilerBytes } from '../src/compiler.js';
import { describePanic, guestImports } from '../src/guest.js';

async function main() {
  const [binaryPath, receiptPath, ...extra] = process.argv.slice(2);
  if (!binaryPath || !receiptPath || extra.length) {
    throw new Error('NOT_EXECUTED: provide external private compiler Wasm and artifact receipt');
  }
  const candidate = JSON.parse(await readFile(new URL('../release-candidates/rust-wasm-new-class-2026-11-07.json', import.meta.url), 'utf8'));
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const bytes = await readFile(binaryPath);
  assert.equal(candidate.schema, 'atto.playground.compiler.candidate.v1');
  assert.equal(candidate.publish_authorized, false, 'candidate is not a public release authorization');
  assert.equal(candidate.source_repository, 'atto-lang/atto-source.rs');
  assert.match(candidate.source_head, /^[a-f0-9]{40}$/);
  assert.match(candidate.source_tree, /^[a-f0-9]{40}$/);
  assert.equal(receipt.schema, 'atto.browser.compiler.artifact.v1');
  for (const key of ['source_head', 'source_tree', 'compiler_sha256', 'compiler_bytes', 'target', 'guest_abi']) {
    assert.equal(receipt[key], candidate[key], 'candidate receipt mismatch: ' + key);
  }
  assert.equal(receipt.abi, candidate.compiler_abi);
  assert.equal(candidate.compiler_abi, 'atto-playground-v2');
  assert.equal(candidate.guest_abi, 'atto.browser.guest.v1');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.compiler_sha256);
  assert.equal(bytes.length, candidate.compiler_bytes);
  await verifyCompilerBytes(bytes, candidate.compiler_sha256, candidate.compiler_bytes);
  assert.equal(WebAssembly.validate(bytes), true);
  assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
  const compiler = await createCompiler(bytes);
  let passed = 0;
  const pass = title => { ++passed; console.log('PASS PRIVATE ' + passed + ': ' + title); };
  pass('exact-head provenance, compiler SHA-256 and no host imports');

  async function execute(source) {
    const compiled = compiler.compile(source);
    assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
    const module = await WebAssembly.compile(compiled.wasm);
    const out = { text: '', truncated: false };
    const { imports, bind } = guestImports(module, out);
    const instance = await WebAssembly.instantiate(module, imports);
    bind(instance);
    try { return { ok: true, value: instance.exports.main(), stdout: out.text }; }
    catch (error) {
      return { ok: false, panic: instance.exports.panic_code?.value,
        message: describePanic(instance, error), stdout: out.text };
    }
  }
  function reject(source, code) {
    const result = compiler.compile(source);
    assert.equal(result.ok, false, 'incorrectly accepted invalid source');
    assert.match(result.diagnostics?.[0]?.message ?? '', new RegExp('^' + code + ':'), source);
    assert.ok(result.diagnostics[0].line > 0 && result.diagnostics[0].column > 0);
    assert.equal('wasm' in result, false, 'rejection produced executable guest');
  }
  const point = [
    'define class Point as', '  int x: 40', '  int y: 2', '  bool active: true', 'end',
    'pub fnc main(): int {', '  val p = new Point();',
    '  if p.active then return p.x + p.y; else return 0; fi', '}'
  ].join('\n');
  assert.deepEqual([ (await execute(point)).value, (await execute('pub fnc main(): int { return 6 * 7; }')).value ], [42n, 42n]);
  pass('class/new and scalar compile into actual guest Wasm returning 42');
  reject(point.replace('new Point()', 'Point()'), 'E_NEW_REQUIRED');
  reject(point.replace('p.x + p.y', 'p.missing'), 'E_UNKNOWN_FIELD');
  pass('bare constructor and nonexistent field fail closed without Wasm');
  const en = [
    'define enum Status as Pending, Ready end', 'pub fnc main(): int {',
    '  val s: Status = Status.Ready;', '  if s eq Status.Ready then return 42; else return 0; fi', '}'
  ].join('\n');
  assert.equal((await execute(en)).value, 42n);
  reject(en.replaceAll('Status.Ready', 'Status.Missing'), 'E_UNKNOWN_VARIANT');
  pass('nominal enum guest execution and unknown-variant rejection');
  for (const op of ['%', '^', '^^']) reject('pub fnc main(): int { return 7 ' + op + ' 2; }', 'E_UNSUPPORTED');
  reject('define actor A as end\npub fnc main(): int { val a = spawn A(); return 0; }', 'E_UNSUPPORTED');
  pass('removed operators and unsupported actor execution fail closed');
  const eager = [
    'fnc crash(): bool {', '  stdio.println("rhs");',
    '  val max_value = 9223372036854775807;', '  return max_value + 1 eq 0;', '}',
    'pub fnc main(): int {', '  if false, crash() then return 0; fi', '  return 42;', '}'
  ].join('\n');
  const trapped = await execute(eager);
  assert.deepEqual([trapped.ok, trapped.panic, trapped.message, trapped.stdout],
    [false, 1, 'E_PANIC: integer overflow', 'rhs\n']);
  pass('eager condition evaluates RHS and reports checked overflow');
  const heap = [
    'define class Unit as', '  int value: 1', 'end',
    'pub fnc main(): int {', '  for (let i = 0; i < 10000; i++) do',
    '    val item = new Unit();', '  done', '  return 0;', '}'
  ].join('\n');
  const exhausted = await execute(heap);
  assert.deepEqual([exhausted.ok, exhausted.panic, exhausted.message],
    [false, 3, 'E_PANIC: class heap exhausted (64 KiB guest limit)']);
  pass('bounded class heap panics through real playground guest adapter');
  assert.equal((await execute(point)).value, 42n);
  pass('recovery after compile rejects and guest panics');
  console.log('PASS: ' + passed + ' PRIVATE candidate checks; PUBLIC_RELEASE=NOT_AUTHORIZED; LIVE_HTTPS=NOT_EXECUTED');
}
await main().catch(error => { console.error('FAIL PRIVATE candidate: ' + error.message); process.exitCode = 1; });
