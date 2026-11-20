/** Independent real-Chromium execution of the JSPI async/2 tenant bridge.
 * Serves only pinned source modules and runs a real core-Wasm fixture.
 * No compiler vendor binary is needed or claimed to have async syntax.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const profile = await mkdtemp(join(tmpdir(),'atto-jspi-e2e-'));
const allowed = new Set([
  'runner-worker.js','actor-abi-version.js','guest.js','tenant-actor-host.js','actor-host.js',
  'task-host.js','wasm-memory-admission.js'
]);
const server = createServer(async (req,res)=>{
  const path = new URL(req.url,'http://localhost').pathname;
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
  if (path === '/play/') {
    res.writeHead(200,{'Content-Type':'text/html'});
    res.end('<!doctype html><title>Atto JSPI worker integration</title>');
    return;
  }
  const m = /^\/play\/src\/([A-Za-z0-9-]+\.js)$/.exec(path);
  if (!m || !allowed.has(m[1])) {res.writeHead(404);res.end();return;}
  try {
    const bytes=await readFile(new URL('../src/'+m[1], import.meta.url));
    res.writeHead(200,{'Content-Type':'text/javascript','X-Content-Type-Options':'nosniff'});
    res.end(bytes);
  } catch {res.writeHead(404);res.end();}
});
const delay = ms => new Promise(r=>setTimeout(r,ms));
const withDeadline = async(p,ms=8000)=>{
  let timer;
  try{return await Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('browser test deadline')),ms);})]);}
  finally{clearTimeout(timer);}
};
let chrome,socket,started=false;
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  started=true;
  const url='http://127.0.0.1:'+server.address().port+'/play/';
  chrome=spawn(process.env.CHROME_BIN||'chromium',[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
    '--no-first-run','--no-proxy-server','--remote-debugging-port=0',
    '--user-data-dir='+profile,'about:blank'
  ],{stdio:['ignore','ignore','pipe']});
  let err='';
  chrome.stderr.on('data',b=>{err=(err+b.toString()).slice(-4000);});
  chrome.on('error',e=>{err+=e.message;});
  let port;
  for(let i=0;i<120;i++){
    if(chrome.exitCode!==null)throw Error('Chromium exited: '+err);
    try {
      port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
      if(port>0)break;
    } catch {}
    await delay(100);
  }
  assert.ok(port>0,'Chromium debug endpoint unavailable '+err);
  const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const target=pages.find(p=>p.type==='page'&&p.webSocketDebuggerUrl);
  assert.ok(target,'No browser page');
  socket=new WebSocket(target.webSocketDebuggerUrl);
  await withDeadline(new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',reject,{once:true});
  }));
  const pending=new Map();let id=0;
  socket.addEventListener('message',e=>{
    const result=JSON.parse(e.data),p=pending.get(result.id);
    if(!p)return;
    pending.delete(result.id);
    if(result.error)p.reject(Error(result.error.message));else p.resolve(result.result);
  });
  const command=(method,params={})=>withDeadline(new Promise((resolve,reject)=>{
    const next=++id;pending.set(next,{resolve,reject});
    socket.send(JSON.stringify({id:next,method,params}));
  }));
  const evaluate=async expression=>{
    const x=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(x.exceptionDetails)throw Error('Browser evaluation failed: '+(x.exceptionDetails.text||JSON.stringify(x.exceptionDetails)));
    return x.result.value;
  };
  await command('Page.enable');
  await command('Page.navigate',{url});
  await delay(250);
  const result=await evaluate(`(async()=>{
    const leb=n=>{const a=[];do{let b=n&127;n>>>=7;a.push(n?b|128:b);}while(n);return a;};
    const name=s=>{const b=[...new TextEncoder().encode(s)];return [...leb(b.length),...b];};
    const sec=(id,b)=>[id,...leb(b.length),...b];
    const body=[0,0x42,42,0x10,0,0x0b];
    const wasm=new Uint8Array([
      0,97,115,109,1,0,0,0,
      ...sec(1,[2,0x60,0,0,0x60,0,1,0x7e]),
      ...sec(2,[1,...name('atto'),...name('cooperate'),0,0]),
      ...sec(3,[1,1]),
      ...sec(7,[1,...name('main'),0,1]),
      ...sec(10,[1,...leb(body.length),...body]),
      ...sec(0,[...name('atto.async'),2])
    ]);
    if(!WebAssembly.validate(wasm))throw Error('invalid real-Wasm fixture');
    const worker=new Worker('/play/src/runner-worker.js',{type:'module'});
    try{return await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('tenant JSPI timed out')),5000);
      worker.onmessage=e=>{clearTimeout(timer);resolve(e.data);};
      worker.onerror=e=>{clearTimeout(timer);reject(Error(e.message||'tenant worker error'));};
      worker.postMessage({wasm});
    });}finally{worker.terminate();}
  })()`);
  assert.equal(result.ok,true,result.message);
  assert.equal(result.value,'42');
  assert.equal(result.cooperativeYields,1);
  assert.equal(result.actors,0);
  console.log('PASS: real Chromium JSPI cooperate yields once and returns 42 on isolated tenant Worker');
  // Native WebAssembly JSPI cancellation oracle, separate from compiler .atto.
  // This guest actually calls atto.sleep_ms(1000) and suspends a Wasm stack.
  // Closing the host must withdraw its timer, wake the continuation and wait
  // for quiescence, rather than report cancellation from the Future handle alone.
  const cancelled = await evaluate(`(async()=>{
    const {createAsyncTaskHost}=await import('/play/src/task-host.js');
    const leb=n=>{const a=[];do{let b=n&127;n>>>=7;a.push(n?b|128:b);}while(n);return a;};
    const name=s=>{const b=[...new TextEncoder().encode(s)];return [...leb(b.length),...b];};
    const sec=(id,b)=>[id,...leb(b.length),...b];
    const wasm=new Uint8Array([
      0,97,115,109,1,0,0,0,
      // type0: (i64)->i64, type1: ()->i64
      ...sec(1,[2,0x60,1,0x7e,1,0x7e,0x60,0,1,0x7e]),
      ...sec(2,[1,...name('atto'),...name('sleep_ms'),0,0]),
      ...sec(3,[1,1]),
      ...sec(7,[1,...name('main'),0,1]),
      // main: i64.const 1000; call imported sleep_ms; drop; i64.const 42
      ...sec(10,[1,9,0,0x42,0xe8,0x07,0x10,0,0x1a,0x42,42,0x0b]),
      ...sec(0,[...name('atto.async'),2])
    ]);
    if(!WebAssembly.validate(wasm))throw Error('invalid cancellable core Wasm fixture');
    const module=new WebAssembly.Module(wasm);
    const host=createAsyncTaskHost(module);
    const instance=new WebAssembly.Instance(module,{atto:host.imports});
    host.bind(instance);
    const running=host.runMain().then(
      value=>({status:'fulfilled',value:String(value)}),
      error=>({status:'rejected',message:String(error.message)})
    );
    await new Promise(resolve=>setTimeout(resolve,20));
    const before={
      pending:host.pendingHostWaitCount,
      quiescent:host.physicallyQuiescent
    };
    await host.close();
    const outcome=await running;
    return {before,outcome,pending:host.pendingHostWaitCount,
      active:host.activeTaskCount,quiescent:host.physicallyQuiescent};
  })()`);
  assert.equal(cancelled.before.pending,1,'real JSPI sleep must be pending at cancellation');
  assert.equal(cancelled.before.quiescent,false,'pending Wasm continuation cannot be retired');
  assert.equal(cancelled.outcome.status,'rejected','cancellation cannot synthesize an int result');
  assert.match(cancelled.outcome.message,/E_ASYNC: task scope cancelled/);
  assert.equal(cancelled.pending,0,'native sleep timeout must be removed');
  assert.equal(cancelled.active,0);
  assert.equal(cancelled.quiescent,true,'scope must settle real JSPI continuation');
  console.log('PASS: real Chromium JSPI timed guest cancellation withdraws callback and retires continuation');

} finally {
  try {socket?.close();} catch {}
  if(chrome&&chrome.exitCode===null){
    const p=new Promise(resolve=>chrome.once('close',resolve));
    chrome.kill('SIGKILL');
    await withDeadline(p,3000).catch(()=>{});
  }
  if(started)await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
