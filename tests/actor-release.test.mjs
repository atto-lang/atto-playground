import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PAGES_ASSETS, packagePages } from '../scripts/package-pages.mjs';

test('public packager rejects forged actor ABI and incomplete compiler provenance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atto-actor-release-negative-'));
  try {
    const sourceRoot = resolve(new URL('..', import.meta.url).pathname);
    for (const file of PAGES_ASSETS) {
      await mkdir(dirname(join(root,file)),{recursive:true});
      await copyFile(join(sourceRoot,file),join(root,file));
    }
    const receiptPath=join(root,'public/atto_compiler.receipt.json');
    const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
    // A forged actor ABI claim must not pass, regardless of whether a later
    // authorized compiler eventually adds the compile_actor export.
    const module = new WebAssembly.Module(await readFile(join(root,'public/atto_compiler.wasm')));
    const actorSupported=WebAssembly.Module.exports(module).some(x=>x.name==='compile_actor'&&x.kind==='function');
    receipt.actor_abi=actorSupported ? 'atto.browser.actor.WRONG' : 'atto.browser.actor.scalar.v0';
    await writeFile(receiptPath,JSON.stringify(receipt));
    await assert.rejects(packagePages({root}),/Compiler actor ABI export and release receipt do not match/);
    delete receipt.actor_abi;
    receipt.source_tree='missing-tree';
    await writeFile(receiptPath,JSON.stringify(receipt));
    await assert.rejects(packagePages({root}),/Compiler receipt, pinned digest or byte length does not match/);
    assert.equal(await readFile(join(root,'public/atto_compiler.wasm'),'binary').then(b=>b.length)>0,true);
  } finally {
    await rm(root,{recursive:true,force:true,maxRetries:3});
  }
});
