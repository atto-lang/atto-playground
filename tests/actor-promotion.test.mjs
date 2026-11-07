import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { verifyActorReleaseReceipt } from '../scripts/actor-release-gate.mjs';

const sha = x => x.repeat(40);
const digest = x => x.repeat(64);
const actorEvidence = () => ({
  schema: 'atto.browser.compiler.vendor.v1',
  source_head: sha('a'), source_tree: sha('b'),
  compiler_sha256: digest('c'),
  actor_abi: 'atto.browser.actor.scalar.v0',
  source_ci_run_id: '42403674399',
  source_ci_job_id: '12849643210',
  source_ci_artifact_id: '13586483051',
  source_ci_compiler_sha256: digest('c')
});
const approval = () => {
  const r=actorEvidence();
  return {
    source_head:r.source_head,source_tree:r.source_tree,
    compiler_sha256:r.compiler_sha256,
    source_ci_run_id:r.source_ci_run_id,
    source_ci_job_id:r.source_ci_job_id,
    source_ci_artifact_id:r.source_ci_artifact_id
  };
};

test('legacy pinned compiler cannot claim actor support or forge actor CI metadata', () => {
  assert.deepEqual(verifyActorReleaseReceipt({source_head:sha('a')},false),{actor:false});
  assert.throws(()=>verifyActorReleaseReceipt(actorEvidence(),false),/E_ACTOR_RELEASE/);
  const forged=actorEvidence();
  delete forged.actor_abi;
  assert.throws(()=>verifyActorReleaseReceipt(forged,false),/E_ACTOR_RELEASE/);
});

test('actor-capable compiler binds immutable source/CI artifact proof to administrator approval', () => {
  const receipt=actorEvidence();
  assert.equal(verifyActorReleaseReceipt(receipt,true,approval()).actor,true);
  assert.equal(verifyActorReleaseReceipt(receipt,true,null).actor,true, 'unprivileged CI can structurally verify without granting approval');
  assert.throws(()=>verifyActorReleaseReceipt(receipt,true,{}),/missing or mismatched independent approval/);
  assert.throws(()=>verifyActorReleaseReceipt(receipt,true,{...approval(),source_tree:sha('e')}),/approval for source_tree/);
  assert.throws(()=>verifyActorReleaseReceipt(receipt,true,{...approval(),compiler_sha256:digest('e')}),/approval for compiler_sha256/);
  assert.throws(()=>verifyActorReleaseReceipt(receipt,true,{...approval(),source_ci_run_id:'42403674390'}),/approval for source_ci_run_id/);
  assert.throws(()=>verifyActorReleaseReceipt(receipt,true,{...approval(),source_ci_artifact_id:'999999'}),/approval for source_ci_artifact_id/);
});

test('actor admission rejects missing, ambiguous or forged source-owned provenance', () => {
  for(const key of ['source_head','source_tree','source_ci_run_id',
      'source_ci_job_id','source_ci_artifact_id','source_ci_compiler_sha256']) {
    const receipt=actorEvidence();
    delete receipt[key];
    assert.throws(()=>verifyActorReleaseReceipt(receipt,true),/E_ACTOR_RELEASE/,key);
  }
  for(const [key,val] of [
    ['source_head','not-a-sha'], ['source_tree','A'.repeat(40)],
    ['source_ci_run_id','0'], ['source_ci_job_id','-1'],
    ['source_ci_artifact_id','12x'], ['source_ci_compiler_sha256',digest('f')],
    ['actor_abi','atto.browser.actor.scalar.v1']
  ]) {
    assert.throws(()=>verifyActorReleaseReceipt({...actorEvidence(),[key]:val},true),/E_ACTOR_RELEASE/,key);
  }
});

test('read-only release CLI refuses to infer actor authorization from current legacy compiler', () => {
  const cwd=new URL('..',import.meta.url).pathname;
  const result=execFileSync(process.execPath,['scripts/actor-release-gate.mjs'],{
    cwd,encoding:'utf8',timeout:8000,
    env:{PATH:process.env.PATH}
  });
  assert.match(result,/PASS: legacy compiler/);
});
