import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPlaygroundServer} from '../scripts/serve.mjs';

test('Atto-only local server restricts paths, methods and MIME', async t => {
  const root = await mkdtemp(join(tmpdir(), 'atto-serve-'));
  const srv = createPlaygroundServer({root});
  t.after(async () => {await new Promise(r => srv.close(r)); await rm(root, {recursive:true,force:true});});
  await mkdir(join(root, 'public'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'tests'));
  await writeFile(join(root,'index.html'), '<h1>AttoLang</h1>');
  await writeFile(join(root,'public/atto_compiler.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  await writeFile(join(root,'tests/secret.mjs'),'secret');
  await symlink(join(root, 'tests/secret.mjs'), join(root,'src/app.js'));
  await new Promise(resolve => srv.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + srv.address().port;
  const index = await fetch(origin+'/');
  assert.equal(index.status,200);
  assert.match(await index.text(),/AttoLang/);
  assert.match(index.headers.get('content-security-policy'),/default-src 'none'/);
  assert.equal(index.headers.get('x-content-type-options'),'nosniff');
  const wasm=await fetch(origin+'/public/atto_compiler.wasm');
  assert.equal(wasm.status,200);
  assert.equal(wasm.headers.get('content-type'),'application/wasm');
  assert.equal((await wasm.arrayBuffer()).byteLength,8);
  assert.equal((await fetch(origin+'/index.html',{method:'HEAD'})).status,200);
  assert.equal((await fetch(origin+'/index.html',{method:'POST'})).status,405);
  for (const path of ['/tests/secret.mjs','/package.json','/.github/workflows/ci.yml',
    '/src/app.js','/%2e%2e%2ftests/secret.mjs','/%5csecret','/%00']) {
    assert.notEqual((await fetch(origin+path)).status,200,path);
  }
});
