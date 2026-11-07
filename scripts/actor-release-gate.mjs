/** Source-free promotion checks for actor-capable Wasm compiler releases.
 * These checks bind the checked-in bytes/receipt to admin-managed approval
 * values; they do not create, infer, or grant independent reviewer approval.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ACTOR_RELEASE_ABI = 'atto.browser.actor.scalar.v0';
const SHA40 = /^[a-f0-9]{40}$/;
const SHA64 = /^[a-f0-9]{64}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,18}$/;
const CI_KEYS = ['source_ci_run_id','source_ci_job_id','source_ci_artifact_id','source_ci_compiler_sha256'];

export function verifyActorReleaseReceipt(receipt, hasActorExport, approval = null) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new Error('E_ACTOR_RELEASE: invalid compiler receipt');
  }
  if (typeof hasActorExport !== 'boolean') throw new TypeError('Expected actor export boolean');
  if (!hasActorExport) {
    if (receipt.actor_abi !== undefined || CI_KEYS.some(k => receipt[k] !== undefined)) {
      throw new Error('E_ACTOR_RELEASE: legacy compiler cannot claim actor CI provenance');
    }
    return { actor: false };
  }
  if (receipt.actor_abi !== ACTOR_RELEASE_ABI ||
      !SHA40.test(receipt.source_head ?? '') ||
      !SHA40.test(receipt.source_tree ?? '') ||
      !SHA64.test(receipt.compiler_sha256 ?? '') ||
      CI_KEYS.slice(0,3).some(k => !POSITIVE_ID.test(receipt[k] ?? '')) ||
      receipt.source_ci_compiler_sha256 !== receipt.compiler_sha256) {
    throw new Error('E_ACTOR_RELEASE: actor artifact lacks exact source/CI receipt or digest');
  }
  if (approval !== null) {
    const pairs = [
      ['compiler_sha256','compiler_sha256'],
      ['source_head','source_head'],
      ['source_tree','source_tree'],
      ['source_ci_run_id','source_ci_run_id'],
      ['source_ci_job_id','source_ci_job_id'],
      ['source_ci_artifact_id','source_ci_artifact_id']
    ];
    for (const [actual,expected] of pairs) {
      if (typeof approval[expected] !== 'string' ||
          approval[expected] !== receipt[actual]) {
        throw new Error('E_ACTOR_RELEASE: missing or mismatched independent approval for ' + actual);
      }
    }
  }
  return { actor: true, source_head: receipt.source_head, source_tree: receipt.source_tree };
}

async function verifyCommand() {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const receipt = JSON.parse(await readFile(resolve(root,'public/atto_compiler.receipt.json'),'utf8'));
  const bytes = await readFile(resolve(root,'public/atto_compiler.wasm'));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!WebAssembly.validate(bytes) || actual !== receipt.compiler_sha256) {
    throw new Error('E_ACTOR_RELEASE: binary does not match receipted compiler SHA-256');
  }
  const mod = new WebAssembly.Module(bytes);
  if (WebAssembly.Module.imports(mod).length) {
    throw new Error('E_ACTOR_RELEASE: compiler must not import host capabilities');
  }
  const enabled = WebAssembly.Module.exports(mod).some(e=>e.kind==='function'&&e.name==='compile_actor');
  const approval = {
    compiler_sha256: process.env.ATTO_PUBLIC_COMPILER_SHA256 ?? '',
    source_head: process.env.ATTO_PUBLIC_ACTOR_SOURCE_HEAD ?? '',
    source_tree: process.env.ATTO_PUBLIC_ACTOR_SOURCE_TREE ?? '',
    source_ci_run_id: process.env.ATTO_PUBLIC_ACTOR_CI_RUN_ID ?? '',
    source_ci_job_id: process.env.ATTO_PUBLIC_ACTOR_CI_JOB_ID ?? '',
    source_ci_artifact_id: process.env.ATTO_PUBLIC_ACTOR_CI_ARTIFACT_ID ?? '',
  };
  const result = verifyActorReleaseReceipt(receipt, enabled, enabled ? approval : null);
  // The release workflow separately compares ATTO_PUBLIC_COMPILER_SHA256 to
  // its explicit dispatch input and the actual binary for BOTH compiler kinds.
  process.stdout.write(result.actor
    ? 'PASS: actor source/tree/CI artifact and public hash bound to administrator approval\n'
    : 'PASS: legacy compiler, no actor runtime release claimed\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verifyCommand();
}
