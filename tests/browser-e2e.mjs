/** Chromium end-to-end tests using real browser controls and actual WebAssembly.
 * No Playwright package needed; only Node 22 and a Chromium executable.
 */
import assert from 'node:assert/strict';
import { COUNTER_WASM, LOOP_WASM } from './actor-fixture.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, readdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.env.ATTO_STATIC_ROOT ? resolve(process.env.ATTO_STATIC_ROOT) : resolve(new URL('..', import.meta.url).pathname);
const mime = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript', '.wasm':'application/wasm', '.md':'text/plain' };
const requests = [];
const server = createServer(async (req, res) => {
  requests.push({method:req.method, url:req.url});
  try {
    const parsed = new URL(req.url, 'http://localhost');
    let name = decodeURIComponent(parsed.pathname);
    if (!name.startsWith('/play/')) throw new Error('outside playground');
    name = name.slice('/play/'.length) || 'index.html';
    const file = resolve(root, name);
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) throw new Error('non-file');
    res.writeHead(200, {'Content-Type':mime[extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});
    res.end(await readFile(file));
  } catch {res.writeHead(404);res.end('Not found');}
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function poll(fn, label, attempts=160) {
  let last;
  for (let i=0;i<attempts;i++) {
    try {const result=await fn(); if(result) return result; last=result;}
    catch(e) {last=e.message;}
    await sleep(80);
  }
  throw new Error(label+' timed out: '+JSON.stringify(last));
}
async function deadline(promise, ms) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('CDP deadline exceeded')),ms);})]);}
  finally {clearTimeout(timer);}
}
const profile=await mkdtemp(join(tmpdir(),'atto-e2e-profile-'));
const downloads=await mkdtemp(join(tmpdir(),'atto-e2e-download-'));
let chrome, socket, listening=false;
let passed=0;
function ok(label) {passed++;console.log('PASS E2E '+passed+': '+label);}
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  listening=true;
  const base='http://127.0.0.1:'+server.address().port+'/play/';
  chrome=spawn(process.env.CHROME_BIN||'chromium',[
    '--headless=new','--no-sandbox','--disable-dev-shm-usage','--disable-gpu',
    '--disable-background-networking','--no-first-run','--no-proxy-server',
    '--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'
  ],{stdio:['ignore','ignore','pipe']});
  let chromeErrors='';
  chrome.stderr.on('data',chunk=>{chromeErrors=(chromeErrors+chunk.toString()).slice(-4000);});
  chrome.on('error',error=>{chromeErrors+=error.message;});
  const port=await poll(async()=>{
    if(chrome.exitCode!==null)throw new Error(chromeErrors);
    try {const n=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);return n>0?n:null;}
    catch{return null;}
  },'Chromium debug port',250);
  const pages=await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const page=pages.find(item=>item.type==='page'&&item.webSocketDebuggerUrl);
  assert.ok(page,'Chromium page target missing');
  socket=new WebSocket(page.webSocketDebuggerUrl);
  await deadline(new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});}),5000);
  let id=0;const pending=new Map();
  socket.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(!pending.has(message.id))return;
    const pair=pending.get(message.id);pending.delete(message.id);
    if(message.error)pair.reject(new Error(message.error.message));else pair.resolve(message.result);
  });
  function cdp(method,params={}) {
    return deadline(new Promise((resolve,reject)=>{
      const next=++id;pending.set(next,{resolve,reject});
      socket.send(JSON.stringify({id:next,method,params}));
    }),6000);
  }
  async function js(expression) {
    const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(r.exceptionDetails)throw new Error(r.exceptionDetails.text);
    return r.result?.value;
  }
  const snapshot="(()=>{const q=x=>document.querySelector(x);return {loaded:!!q('#source'),source:q('#source')?.value,kind:q('#summary')?.dataset.kind,output:q('#output')?.textContent,diagnostics:q('#diagnostics')?.textContent,bytes:q('#bytes')?.textContent,downloadDisabled:q('#download')?.disabled,runDisabled:q('#run')?.disabled,stopDisabled:q('#stop')?.disabled,hash:location.hash,injected:window.__attoInjected===true};})()";
  const view=()=>js(snapshot);
  async function navigate(url) {
    const result=await cdp('Page.navigate',{url});
    assert.ok(!result.errorText,'Navigation failed: '+result.errorText);
    return poll(async()=>{const s=await view();return s?.loaded&&s.source?.includes('fnc main')?s:null;},'DOM navigation');
  }
  const click=id=>js("document.querySelector("+JSON.stringify('#'+id)+").click()");
  const source=text=>js("(()=>{const e=document.querySelector('#source');e.value="+JSON.stringify(text)+";e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  // examples are fetched .atto files, so wait for the editor to be replaced
  const example=async name=>{
    await js("(()=>{const e=document.querySelector('#example');e.value="+JSON.stringify(name)+";e.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await poll(async()=>(await view())?.output?.includes('Source changed'),'example '+name+' loaded');
  };
  async function run(kind,expected) {
    await click('run');
    return poll(async()=>{
      const s=await view();
      return !s?.runDisabled&&s.kind===kind&&(s.output?.includes(expected)||s.diagnostics?.includes(expected))?s:null;
    },'Run '+kind+' '+expected);
  }
  await cdp('Page.enable');
  await cdp('Runtime.enable');
  await cdp('Page.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await navigate(base);
  ok('static site resolves under /play/');

  const unformatted='fnc main() -> int {\nreturn 42;\n}\n';
  await source(unformatted);
  await click('check-format');
  await poll(async()=> (await js("document.querySelector('#status').textContent"))?.includes('Formatting differs'), 'format check (no mutation)');
  assert.equal((await view()).source,unformatted);
  await click('format');
  const formatted=await poll(async()=>{const s=await view();return s.source?.includes('\n  return 42;\n')?s:null;},'real formatter in browser worker');
  assert.equal(formatted.source.includes('\n  return 42;\n'),true);
  assert.equal(await js("document.querySelector('#syntax-layer').textContent"),formatted.source);
  await click('format');
  await poll(async()=> (await js("document.querySelector('#status').textContent"))?.includes('Already canonically formatted'),'format idempotence');
  assert.equal((await view()).source,formatted.source);
  await run('success','main() → 42');
  ok('canonical Rust formatter executes in browser worker; check is nonmutating, format idempotent and compiler still works');
  const malformed='fnc identity(int x) -> int do return x; end\n';
  await source(malformed);
  await click('format');
  await poll(async()=> (await js("document.querySelector('#status').textContent"))?.includes('Formatter rejected source'),'formatter failure');
  assert.equal((await view()).source,malformed);
  ok('formatter rejects invalid syntax without overwriting edited source');
  await example('hello');

  // Custom program library and syntax mirror, both on the real static origin.
  const customSource='fnc main() -> int { return 20 + 22; }';
  await js("(()=>{const e=document.querySelector('#example');e.value='custom:new';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await source(customSource);
  await js("(()=>{document.querySelector('#program-name').value='Demo 42';document.querySelector('#save-custom').click()})()");
  const saved=await js("(()=>{const x=JSON.parse(localStorage.getItem('atto.playground.saved-programs.v1'));return {name:x?.[0]?.name,source:x?.[0]?.source,selected:document.querySelector('#example').value}})()");
  assert.deepEqual(saved,{name:'Demo 42',source:customSource,selected:'saved:Demo 42'});
  assert.equal(await js("document.querySelector('#syntax-layer .tok-keyword')?.textContent"),'fnc');
  assert.equal(await js("document.querySelector('#syntax-layer').textContent"),customSource);
  ok('custom + saves a named program in browser localStorage with syntax coloring');
  await example('primes');
  await js("(()=>{const e=document.querySelector('#example');e.value='saved:Demo 42';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  assert.equal((await view()).source,customSource);
  await run('success','main() → 42');
  ok('saved program reloads from the custom dropdown and compiles in real Wasm');
  await cdp('Page.navigate',{url:'about:blank'});
  await navigate(base);
  await js("(()=>{const e=document.querySelector('#example');e.value='saved:Demo 42';e.dispatchEvent(new Event('change',{bubbles:true}));})()");
  assert.equal((await view()).source,customSource);
  await example('hello');
  await source('// <img src=x onerror="window.__attoInjected=true">\nfnc main() -> int { return 42; }');
  assert.equal(await js("document.querySelector('#syntax-layer img')!==null"),false);
  assert.equal(await js("document.querySelector('#syntax-layer').textContent"),
    '// <img src=x onerror="window.__attoInjected=true">\nfnc main() -> int { return 42; }');
  assert.equal((await view()).injected,false);
  ok('programs persist after navigation, and highlighted source is never executable HTML');
  await example('hello');
  let s=await run('success','main() → 42');
  assert.match(s.output,/^Hello from WebAssembly!\n42\nmain\(\) → 42/);
  assert.match(s.bytes,/^\d+ bytes$/);
  assert.equal(s.downloadDisabled,false);
  ok('real Run control compiles Atto into Wasm and executes 42');
  assert.equal(await js("document.querySelector('#tab-console').getAttribute('aria-selected')"), 'true');
  await click('tab-wasm');
  const preview=await js("document.querySelector('#wasm-preview').textContent");
  assert.match(preview,/WebAssembly binary\nSize: \d+ bytes\nHeader and first \d+ bytes:\n00 61 73 6d/);
  assert.equal(await js("document.querySelector('#panel-console').hidden"),true);
  await click('tab-console');
  ok('accessible tabs expose a bounded Wasm hex preview without replacing the console');
  await click('download');
  const wasm=await poll(async()=>{
    const files=(await readdir(downloads)).filter(n=>n.endsWith('.wasm'));
    if(!files.length)return null;
    const bytes=await readFile(join(downloads,files[0]));
    return WebAssembly.validate(bytes)?bytes:null;
  },'downloaded binary');
  const printed=[];
  const atto={print_i64:v=>printed.push(String(v)),print_bool:v=>printed.push(String(!!v)),print_str:()=>printed.push('str'),print_newline:()=>{}};
  assert.equal((await WebAssembly.instantiate(wasm,{atto})).instance.exports.main(),42n);
  assert.deepEqual(printed,['str','42']);
  ok('downloaded real guest Wasm validates and executes');
  await source('fnc main() -> int { return 17 + 8; }');
  s=await view();
  assert.equal(s.bytes,'—');
  assert.equal(s.downloadDisabled,true);
  await run('success','main() → 25');
  ok('editing invalidates old download and changes guest result');
  await example('primes');
  s=await run('success','main() → 10');
  assert.match(s.output,/^2\n3\n5\n7\n11\n13\n17\n19\n23\n29\nmain\(\) → 10/);
  ok('loops example executes with stdout');
  await example('error');
  s=await run('error','E_IMMUTABLE');
  assert.equal(s.bytes,'—');assert.equal(s.downloadDisabled,true);
  ok('immutable reassignment rejected without output artifact');
  assert.equal(await js("document.querySelector('#tab-diagnostics').getAttribute('aria-selected')"),'true');
  assert.equal(await js("document.querySelector('#diagnostics button')?.tagName"),'BUTTON');
  await js("document.querySelector('#diagnostics button').click()");
  assert.equal(await js("document.activeElement?.id"),'source');
  ok('compiler errors switch to Diagnostics and jump to the native editor');
  await source('fnc main() -> int { return 2 + ; }');
  s=await run('error','E_SYNTAX');
  assert.equal(s.downloadDisabled,true);
  ok('syntax error rejected in UI');
  await source('fnc zero(): int { return 0; }\nfnc main() -> int { return 42 % zero(); }');
  s=await run('error','E_PANIC: division by zero');
  assert.match(s.bytes,/^\d+ bytes$/);
  ok('runtime panic distinguished from compile error');
  await example('overflow');
  s=await run('error','E_PANIC: integer overflow');
  assert.match(s.output,/4611686018427387904\nE_PANIC: integer overflow/);
  ok('checked int overflow panics and keeps earlier output');
  await source('fnc main() -> int { loop { } }');
  s=await run('error','deadline');
  ok('infinite loop is stopped by the worker deadline');
  await source('fnc main() -> int { return 42; }'+' '.repeat(70000));
  s=await run('error','E_SOURCE_LIMIT');
  assert.equal(s.downloadDisabled,true);
  ok('oversized source fails closed');
  await source('fnc main() -> int { return 6 * 7; }');
  await run('success','main() → 42');
  ok('recovery from syntax and runtime errors');
  await source('fnc main() -> int {\n  return 41;\n}');
  await js("(()=>{const e=document.querySelector('#source');e.focus();e.setSelectionRange(e.value.indexOf('return'),e.value.indexOf('return'));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));})()");
  assert.match((await view()).source,/\n    return 41;/);
  await js("document.querySelector('#source').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))");
  s=await poll(async()=>{const x=await view();return x?.kind==='success'&&x.output?.includes('main() → 41')&&!x.runDisabled?x:null;},'keyboard shortcut Run');
  ok('Tab indents and Ctrl+Enter invokes the real compiler and runtime');
  const shared='// 🚀 文字\nfnc main() -> int { return 29 + 13; }';
  await source(shared);
  await click('share');
  const hash=await poll(async()=>{const x=(await view()).hash;return x.startsWith('#code=')?x:null;},'share link');
  await cdp('Page.navigate',{url:'about:blank'});
  await navigate(base+hash);
  assert.equal((await view()).source,shared);
  await run('success','main() → 42');
  ok('share URL preserves Unicode source across full reload');
  await source('fnc main() -> int { return 41; }');
  await js("(()=>{document.querySelector('#run').click();document.querySelector('#stop').click();})()");
  s=await view();
  assert.match(s.output,/cancelled/i);
  assert.equal(s.stopDisabled,true);
  await run('success','main() → 41');
  await sleep(3300);
  s=await view();
  assert.equal(s.kind,'success');
  assert.match(s.output,/main\(\) → 41/);
  ok('Stop cancels request and stale completion cannot clobber new run');
  await source('<img src=x onerror="window.__attoInjected=true">');
  s=await run('error','E_TOPLEVEL');
  assert.equal(s.injected,false);
  ok('HTML injection input rejected and not executed');
  // The new source-to-worker UI must never invent actor execution if the
  // pinned compiler lacks compile_actor. When it is approved and vendored,
  // exercise the SAME controls as a real source-to-worker positive E2E.
  const actorCompilerAvailable=await js(`(async()=>{
    const bytes=await (await fetch('/play/public/atto_compiler.wasm')).arrayBuffer();
    const wasm=new WebAssembly.Module(bytes);
    return WebAssembly.Module.exports(wasm).some(e=>e.name==='compile_actor'&&e.kind==='function');
  })()`);
  await click('actor-example');
  assert.match((await view()).source,/define actor Worker/);
  await click('actor-start');
  if (!actorCompilerAvailable) {
    await poll(async()=>await js("document.querySelector('#actor-output').textContent.includes('E_ACTOR_ABI')"),'old pinned actor compiler rejected');
    assert.equal(await js("document.querySelector('#actor-send').disabled"),true);
    assert.equal(await js("document.querySelector('#actor-stop').disabled"),true);
    ok('source-to-worker UI fails closed on pinned compiler lacking compile_actor');
  } else {
    await poll(async()=>await js("document.querySelector('#actor-status').textContent.includes('Actor ready')"),'actor compiler and worker ready');
    await click('actor-send');
    await poll(async()=>await js("document.querySelector('#actor-output').textContent.includes('receive(41) → 42')"),'real source actor sends 41 and receives 42');
    await click('actor-stop');
    assert.equal(await js("document.querySelector('#actor-send').disabled"),true);
    ok('real editor actor source compiled via pinned Wasm, executed in dedicated browser Web Worker and terminated');
  }
  // Editing stops an actor and invalidates any stale worker response.
  await source('pub fnc main(): int { return 42; }');

  // Invalid compiler requests must be denied before fetching any Wasm asset.
  // A fresh worker is used per case so the fetch count is meaningful.
  const compilerFetchCount=requests.filter(r=>r.url?.includes('/play/public/atto_compiler.wasm')).length;
  const prefetchReject=await js(`(async()=>{
    const cases=[
      {kind:'actor',source:'x'.repeat(65537)},
      {kind:'actor',source:'🚀'.repeat(17000)},
      {kind:'bogus',source:'pub fnc main(): int { return 42; }'},
      {kind:'actor',source:42},
    ];
    const replies=[];
    for(const packet of cases){
      const worker=new Worker('/play/src/compiler-worker.js',{type:'module'});
      try {
        const result=await new Promise((resolve,reject)=>{
          const timeout=setTimeout(()=>reject(Error('prefetch rejection deadline')),3000);
          worker.onmessage=e=>{clearTimeout(timeout);resolve(e.data)};
          worker.onerror=()=>{clearTimeout(timeout);reject(Error('compiler worker startup failed'))};
          worker.postMessage(packet);
        });
        replies.push({ok:result.ok,message:result.diagnostics?.[0]?.message});
      } finally {worker.terminate();}
    }
    return replies;
  })()`);
  assert.deepEqual(prefetchReject.map(r=>r.ok),[false,false,false,false]);
  assert.match(prefetchReject[0].message,/^E_SOURCE_LIMIT:/);
  assert.match(prefetchReject[1].message,/^E_SOURCE_LIMIT:/);
  assert.match(prefetchReject[2].message,/Unsupported compile target/);
  assert.match(prefetchReject[3].message,/Source must be text/);
  assert.equal(requests.filter(r=>r.url?.includes('/play/public/atto_compiler.wasm')).length,compilerFetchCount,
    'malformed and oversized inputs must not fetch compiler Wasm');
  ok('direct compiler workers reject oversized UTF-8 and malformed input without fetching compiler Wasm');
  // Execute real Web Workers with separate Wasm instances and FIFO i64 messages.
  // The fixture is hand-assembled Wasm, not yet AttoLang actor source lowering.
  const actorProbe=await js(`(async()=>{
    const {spawnWasmActor}=await import('/play/src/actor-runtime.js');
    const bytes=Uint8Array.from(${JSON.stringify(Array.from(COUNTER_WASM))});
    const a=await spawnWasmActor(bytes);
    const b=await spawnWasmActor(bytes);
    const values=await Promise.all([a.send(40n),a.send(2n)]);
    const isolated=await b.send(7n);
    let invalid=false;
    try { await a.send(1); } catch (e) { invalid=/signed i64/.test(e.message); }
    a.close();
    let closed=false;
    try { await a.send(1n); } catch (e) { closed=/E_ACTOR_CLOSED/.test(e.message); }
    b.close();
    return {values:values.map(String),isolated:String(isolated),invalid,closed};
  })()`);
  assert.deepEqual(actorProbe,{values:['40','42'],isolated:'7',invalid:true,closed:true});
  ok('dedicated Web Workers execute real stateful Wasm actor messages with FIFO, isolation and closure');

  // Concurrent actor mailboxes must remain isolated even under burst traffic.
  // Closing one actor must not invalidate a separate worker or its state.
  const actorIsolationStress=await js(`(async()=>{
    const {spawnWasmActor}=await import('/play/src/actor-runtime.js');
    const bytes=Uint8Array.from([0,97,115,109,1,0,0,0,1,6,1,96,1,126,1,126,3,2,1,0,6,6,1,126,1,66,0,11,7,11,1,7,114,101,99,101,105,118,101,0,0,10,13,1,11,0,35,0,32,0,124,36,0,35,0,11]);
    const actors=await Promise.all(Array.from({length:3},()=>spawnWasmActor(bytes,{timeoutMs:3000})));
    try {
      const groups=await Promise.all(actors.map(async a=>{
        const pending=Array.from({length:16},()=>a.send(1n));
        return (await Promise.all(pending)).map(String);
      }));
      const expected=Array.from({length:16},(_,i)=>String(i+1));
      const isolated=groups.every(g=>g.length===16&&g.every((x,i)=>x===expected[i]));
      actors[1].close();
      let dead=false;
      try {await actors[1].send(1n);} catch(e){dead=/E_ACTOR_CLOSED/.test(e.message);}
      const alive=[await actors[0].send(2n),await actors[2].send(3n)];
      return {isolated,dead,alive:alive.map(String)};
    } finally {actors.forEach(a=>a.close());}
  })()`);
  assert.deepEqual(actorIsolationStress,{isolated:true,dead:true,alive:['18','19']});
  ok('three real actor workers preserve independent FIFO state during mailbox bursts and neighbor closure');
  // Real Chromium sends raw packets to the dedicated worker. Skipped or
  // replayed mailbox IDs must fail before invoking the guest Wasm.
  const sequenceProbe=await js(`(async()=>{
    const bytes=Uint8Array.from(${JSON.stringify(Array.from(COUNTER_WASM))});
    async function attempt(replay) {
      const worker=new Worker('/play/src/actor-worker.js',{type:'module'});
      function response() { return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('actor sequence response deadline')),3000);
        worker.onmessage=e=>{clearTimeout(timer);resolve(e.data)};
        worker.onerror=e=>{clearTimeout(timer);reject(new Error('actor sequence worker error'))};
      }); }
      try {
        let pending=response();
        worker.postMessage({kind:'init',wasm:bytes});
        if((await pending).kind!=='ready')throw new Error('actor not ready');
        if(replay) {
          pending=response();
          worker.postMessage({kind:'message',id:1,value:7n});
          if((await pending).kind!=='result')throw new Error('initial receive failed');
          pending=response();
          worker.postMessage({kind:'message',id:1,value:9n});
        } else {
          pending=response();
          worker.postMessage({kind:'message',id:2,value:9n});
        }
        const failed=await pending;
        return failed.kind==='fault' && /E_ACTOR_PROTOCOL/.test(failed.message);
      } finally { worker.terminate(); }
    }
    return { skipped:await attempt(false),replayed:await attempt(true) };
  })()`);
  assert.deepEqual(sequenceProbe,{skipped:true,replayed:true});
  ok('real browser worker rejects skipped and replayed actor sequence IDs before guest execution');
  // The browser worker must never reopen a failed actor or emit a late
  // 'ready' after a duplicate init has already terminally faulted it.
  const duplicateInitProbe=await js(`(async()=>{
    const worker=new Worker('/play/src/actor-worker.js',{type:'module'});
    const wasm=Uint8Array.from(${JSON.stringify(Array.from(COUNTER_WASM))});
    const packets=[];
    try {
      const fault=new Promise((resolve,reject)=>{
        const deadline=setTimeout(()=>reject(new Error('double-init was not rejected')),3000);
        worker.onmessage=e=>{packets.push(e.data?.kind);if(e.data?.kind==='fault'){clearTimeout(deadline);resolve();}};
        worker.onerror=()=>{clearTimeout(deadline);reject(new Error('double-init worker error'))};
      });
      worker.postMessage({kind:'init',wasm});
      worker.postMessage({kind:'init',wasm});
      await fault;
      await new Promise(resolve=>setTimeout(resolve,150));
      const faultIndex=packets.indexOf('fault');
      return {faults:packets.filter(x=>x==='fault').length,
        lateReady:packets.slice(faultIndex+1).includes('ready'),
        multipleReady:packets.filter(x=>x==='ready').length>1};
    } finally {worker.terminate();}
  })()`);
  assert.deepEqual(duplicateInitProbe,{faults:1,lateReady:false,multipleReady:false});
  ok('real browser worker rejects duplicate initialization without late ready or resurrection');
  const timeoutProbe=await js(`(async()=>{
    const {spawnWasmActor}=await import('/play/src/actor-runtime.js');
    const actor=await spawnWasmActor(Uint8Array.from(${JSON.stringify(Array.from(LOOP_WASM))}),{timeoutMs:100});
    let timeout=false;
    try { await actor.send(1n); } catch (e) { timeout=/E_ACTOR_TIMEOUT/.test(e.message); }
    return {timeout,closed:actor.closed};
  })()`);
  assert.deepEqual(timeoutProbe,{timeout:true,closed:true});
  ok('non-cooperative guest Wasm is terminated by worker deadline');

  // One runaway worker cannot monopolize the browser's actor scheduler or
  // terminate a healthy sibling. Every pending message on the timed-out
  // worker must reject, and the surviving actor must continue accumulating.
  const watchdogIsolation=await js(`(async()=>{
    const {spawnWasmActor}=await import('/play/src/actor-runtime.js');
    const slow=await spawnWasmActor(Uint8Array.from(${JSON.stringify(Array.from(LOOP_WASM))}),{timeoutMs:150,maxMailbox:3});
    const healthy=await spawnWasmActor(Uint8Array.from(${JSON.stringify(Array.from(COUNTER_WASM))}),{timeoutMs:1000});
    try {
      const stuck=[slow.send(1n),slow.send(2n),slow.send(3n)];
      const before=await healthy.send(40n);
      const settled=await Promise.allSettled(stuck);
      const after=await healthy.send(2n);
      return {before:String(before),after:String(after),
        timedOut:settled.every(x=>x.status==='rejected'&&/E_ACTOR_TIMEOUT/.test(x.reason.message)),
        dead:slow.closed,survivorClosed:healthy.closed};
    } finally {slow.close();healthy.close();}
  })()`);
  assert.deepEqual(watchdogIsolation,{before:'40',after:'42',
    timedOut:true,dead:true,survivorClosed:false});
  ok('runaway worker times out all queued messages without poisoning a healthy sibling actor');


  assert.ok(requests.some(r=>r.url.includes('/play/public/atto_compiler.wasm')));
  assert.ok(requests.every(r=>r.method==='GET'),'Unexpected server-side submission of code');
  ok('compiler Wasm served as static GET, no source POST');
  console.log('PASS: '+passed+' real-browser E2E scenarios');
} finally {
  try {socket?.close();}catch{}
  if(chrome&&chrome.exitCode===null){
    const closed=new Promise(resolve=>chrome.once('close',resolve));
    chrome.kill('SIGKILL');
    await deadline(closed,3000).catch(()=>{});
  }
  if(listening) await new Promise(resolve=>server.close(resolve));
  await Promise.all([
    rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100}),
    rm(downloads,{recursive:true,force:true,maxRetries:10,retryDelay:100})
  ]);
}
