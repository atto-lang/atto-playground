// Real Chromium WebAssembly.JSPI test for the exact checked-in task-host.js.
// Run from about:blank with a Blob module (no localhost server/network).
// Raw core Wasm fixture: NOT .atto source compiled through the Rust compiler.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = async (promise, ms = 15000) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_,reject)=>{
      timer = setTimeout(()=>reject(Error('JSPI browser proof deadline')),ms);
    })]);
  } finally { clearTimeout(timer); }
};
const profile = await mkdtemp(join(tmpdir(),'atto-jspi-cancel-'));
let chrome, socket;
try {
  chrome = spawn(process.env.CHROME_BIN || 'chromium', [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-gpu', '--no-first-run', '--no-proxy-server',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'
  ], {stdio:['ignore','ignore','pipe']});
  let stderr = '';
  chrome.stderr.on('data', b => { stderr = (stderr+b.toString()).slice(-3000); });
  chrome.on('error', e => { stderr += e.message; });
  let port;
  for (let i=0;i<120;i++) {
    if (chrome.exitCode !== null) throw Error('Chromium exited: '+stderr);
    try {
      port = Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
      if (port > 0) break;
    } catch {}
    await delay(100);
  }
  assert.ok(port>0,'Chromium CDP port unavailable: '+stderr);
  const pages = await deadline((await fetch('http://127.0.0.1:'+port+'/json/list')).json());
  const target = pages.find(p=>p.type==='page' && p.webSocketDebuggerUrl);
  assert.ok(target,'No Chromium page WebSocket');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await deadline(new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true});
    socket.addEventListener('error',reject,{once:true});
  }));
  let id=0;
  const pending = new Map();
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data), waiter=pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const command=(method,params={})=>deadline(new Promise((resolve,reject)=>{
    const next=++id;
    pending.set(next,{resolve,reject});
    socket.send(JSON.stringify({id:next,method,params}));
  }));
  const evaluate=async expression=>{
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if (result.exceptionDetails) throw Error('Chromium guest failure: '+
      (result.exceptionDetails.exception?.description || result.exceptionDetails.text));
    return result.result.value;
  };
  await command('Page.enable');
  await command('Page.navigate',{url:'about:blank'});
  const hostSource=JSON.stringify(await readFile(new URL('../src/task-host.js',import.meta.url),'utf8'));
  const evidence=await evaluate(`(async()=>{
    if(typeof WebAssembly.Suspending!=='function'||typeof WebAssembly.promising!=='function'){
      throw Error('WebAssembly JSPI is not supported by this browser');
    }
    const url=URL.createObjectURL(new Blob([${hostSource}],{type:'text/javascript'}));
    try{
      const {createAsyncTaskHost}=await import(url);
      const leb=n=>{const a=[];do{let b=n&127;n>>>=7;a.push(n?b|128:b);}while(n);return a;};
      const name=s=>{const b=[...new TextEncoder().encode(s)];return [...leb(b.length),...b];};
      const sec=(id,b)=>[id,...leb(b.length),...b];
      const mkGuest=ms=>{
        const signedMs=ms===1000?[0xe8,0x07]:[0];
        const body=[0,0x42,...signedMs,0x10,0,0x1a,0x42,42,0x0b];
        const bytes=new Uint8Array([
          0,97,115,109,1,0,0,0,
          ...sec(1,[2,0x60,1,0x7e,1,0x7e,0x60,0,1,0x7e]),
          ...sec(2,[1,...name('atto'),...name('sleep_ms'),0,0]),
          ...sec(3,[1,1]),...sec(7,[1,...name('main'),0,1]),
          ...sec(10,[1,...leb(body.length),...body]),
          ...sec(0,[...name('atto.async'),2])
        ]);
        if(!WebAssembly.validate(bytes))throw Error('invalid Wasm fixture');
        return new WebAssembly.Module(bytes);
      };
      const mkHost=ms=>{
        const module=mkGuest(ms);
        const host=createAsyncTaskHost(module);
        const instance=new WebAssembly.Instance(module,{atto:host.imports});
        host.bind(instance);
        return host;
      };
      const successHost=mkHost(0);
      const success=await successHost.runMain();
      const successDrained=successHost.physicallyQuiescent && successHost.pendingHostWaitCount===0;
      const cancelHost=mkHost(1000);
      const running=cancelHost.runMain().then(
        v=>({status:'fulfilled',value:String(v)}),
        e=>({status:'rejected',message:String(e.message)})
      );
      await new Promise(resolve=>setTimeout(resolve,20));
      const before={pending:cancelHost.pendingHostWaitCount,quiescent:cancelHost.physicallyQuiescent};
      await cancelHost.close();
      return {success:String(success),successDrained,before,outcome:await running,
        after:{pending:cancelHost.pendingHostWaitCount,active:cancelHost.activeTaskCount,
          quiescent:cancelHost.physicallyQuiescent}};
    } finally { URL.revokeObjectURL(url); }
  })()`);
  assert.equal(evidence.success,'42');
  assert.equal(evidence.successDrained,true);
  assert.equal(evidence.before.pending,1);
  assert.equal(evidence.before.quiescent,false);
  assert.equal(evidence.outcome.status,'rejected');
  assert.match(evidence.outcome.message,/E_ASYNC: task scope cancelled/);
  assert.deepEqual(evidence.after,{pending:0,active:0,quiescent:true});
  console.log('PASS: native Chromium JSPI core-Wasm happy path + cancelled sleep, exact task-host.js source');
  console.log(JSON.stringify(evidence));
} finally {
  try { socket?.close(); } catch {}
  if(chrome && chrome.exitCode===null){
    chrome.kill('SIGKILL');
    await delay(150);
  }
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
