import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, chmod } from 'node:fs/promises';
import { join, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
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


test('vendoring rejected actor compiler leaves old public bytes, receipt and pin intact', async () => {
  // A small genuine Wasm module models an actor-capable compiler ABI surface.
  // Its run/job/artifact proof is deliberately absent; it MUST be rejected.
  const leb = n => { const a=[]; do {let b=n&127;n=Math.floor(n/128);if(n)b|=128;a.push(b);}while(n);return a; };
  const str = s => [...leb(Buffer.byteLength(s)),...Buffer.from(s)];
  const section = (id,body) => [id,...leb(body.length),...body];
  const bytes=Uint8Array.from([
    0,97,115,109,1,0,0,0,
    ...section(1,[1,0x60,0,1,0x7f]),
    ...section(3,[2,0,0]),
    ...section(7,[2,...str('abi_version'),0,0,...str('compile_actor'),0,1]),
    ...section(10,[2,4,0,0x41,2,0x0b,4,0,0x41,0,0x0b]),
  ]);
  assert.equal(WebAssembly.validate(bytes),true);
  const temp=await mkdtemp(join(tmpdir(),'atto-rejected-vendor-'));
  try {
    const source=join(temp,'source');
    const site=join(temp,'playground');
    const bin=join(temp,'bin');
    await Promise.all([mkdir(source,{recursive:true}),mkdir(join(site,'scripts'),{recursive:true}),
      mkdir(join(site,'public'),{recursive:true}),mkdir(join(site,'src'),{recursive:true}),mkdir(bin)]);
    const scriptPath=join(site,'scripts/vendor-compiler.sh');
    await copyFile(new URL('../scripts/vendor-compiler.sh',import.meta.url),scriptPath);
    await writeFile(join(source,'.gitignore'),'target/\n');
    execFileSync('git',['init','-q',source]);
    execFileSync('git',['-C',source,'add','.gitignore']);
    execFileSync('git',['-C',source,'-c','user.name=Atto Test','-c',
      'user.email=atto-test@example.invalid','commit','-qm','test input']);
    const output=join(source,'target/wasm32-unknown-unknown/release/atto_compiler.wasm');
    await mkdir(join(source,'target/wasm32-unknown-unknown/release'),{recursive:true});
    await writeFile(output,bytes);
    await writeFile(join(bin,'cargo'),'#!/bin/sh\nexit 0\n');
    await writeFile(join(bin,'rustc'),'#!/bin/sh\necho "rustc 1.85.1 (test)"\n');
    await Promise.all([chmod(join(bin,'cargo'),0o755),chmod(join(bin,'rustc'),0o755)]);
    const sentinels=[
      [join(site,'public/atto_compiler.wasm'),Buffer.from('approved compiler remains')],
      [join(site,'public/atto_compiler.receipt.json'),Buffer.from('approved receipt remains')],
      [join(site,'src/compiler-pin.js'),Buffer.from('approved pin remains')],
    ];
    for(const [file,body] of sentinels)await writeFile(file,body);
    const env={...process.env,PATH:bin+delimiter+(process.env.PATH||'')};
    delete env.ATTO_ACTOR_CI_RUN_ID;
    delete env.ATTO_ACTOR_CI_JOB_ID;
    delete env.ATTO_ACTOR_CI_ARTIFACT_ID;
    delete env.ATTO_ACTOR_CI_SHA256;
    assert.equal(spawnSync('sh',['-n',scriptPath],{encoding:'utf8',env}).status,0);
    const run=spawnSync('sh',[scriptPath,source],{encoding:'utf8',env,timeout:15000});
    assert.notEqual(run.status,0,'unapproved actor compiler must not vendor');
    assert.match(run.stderr + run.stdout,/E_ACTOR_RELEASE/);
    for(const [file,body] of sentinels)assert.deepEqual(await readFile(file),body);
  } finally {
    await rm(temp,{recursive:true,force:true,maxRetries:3});
  }
});
