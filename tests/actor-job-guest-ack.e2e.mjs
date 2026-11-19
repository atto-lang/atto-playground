/**
 * Full proof: source-compiled Job<int> -> Wasm -> real tenant host -> ACK.
 * Execute ONLY with a freshly built, exact-source Rust browser compiler:
 * ATTO_JOB_COMPILER_WASM=/path/to/atto_compiler.wasm node --test tests/actor-job-guest-ack.e2e.mjs
 * The website's older pinned compiler cannot compile Job<int>.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames, guestImports, jobActorModes } from '../src/guest.js';
import { createTenantActorHost } from '../src/tenant-actor-host.js';

if (!process.env.ATTO_JOB_COMPILER_WASM) {
  throw new Error('E_JOB_GUEST_PROOF: fresh exact-source Rust Wasm compiler required; no skip or fallback');
}
const compiler = await createCompiler(await readFile(process.env.ATTO_JOB_COMPILER_WASM));
const base = (body, more = '') => [
  'define serial actor Worker as',
  '  receive(Job<int> job): void {',
  body,
  '    return;',
  '  }',
  'end',
  more,
  'pub fnc main(): int { return 0; }'
].join('\n');
const ackBody = [
  '    stdio.println(job.job_id);',
  '    stdio.println(job.correlation_id);',
  '    stdio.println(job.attempt);',
  '    stdio.println(job.payload);',
  '    job.ack();'
].join('\n');

function fixture(source=base(ackBody)) {
  const compile=compiler.compile(source);
  assert.equal(compile.ok,true,JSON.stringify(compile.diagnostics));
  const module=new WebAssembly.Module(compile.wasm);
  const names=actorNames(module);
  const modes=jobActorModes(module,names);
  const out={text:'',truncated:false};
  const host=createTenantActorHost({module,names,out});
  const key=(application_key='orders',namespace='tenant-a',actor_type=0) =>
    ({namespace,application_key,actor_type});
  return {module,modes,host,out,key};
}

test('real compiled Atto receives job_id, correlation_id, attempt and a single ACK', async()=>{
  const f=fixture();
  assert.deepEqual(f.modes,[true]);
  const k=f.key(),ref=f.host.registry.register(k).ref;
  const request={job_id:'invoice:101🚀',target:{kind:'actor',key:k},
    value:42n,attempt:7n,correlation_id:'trace:abc'};
  assert.equal(f.host.jobs.dispatch_job(request).status,'admitted');
  assert.equal(f.host.jobs.inspect('tenant-a','invoice:101🚀').status,'admitted');
  assert.equal(f.out.text,'','enqueue cannot count as completion');
  assert.equal(await f.host.drain(),null);
  assert.deepEqual(f.host.jobs.inspect('tenant-a','invoice:101🚀'),
    {status:'completed',ref});
  assert.equal(f.out.text,'invoice:101🚀\ntrace:abc\n7\n42\n');
  assert.equal(f.host.jobs.dispatch_job(request).status,'duplicate');
  assert.equal(f.out.text,'invoice:101🚀\ntrace:abc\n7\n42\n');
  f.host.close();
});

test('ACK cannot be forged without the matching actor-scoped current job', async()=>{
  const f=fixture(), k=f.key();
  const ref=f.host.registry.register(k).ref;
  assert.throws(()=>f.host.send(f.host.registry.slot_for(ref),99n),/E_ACTOR_JOB_REQUIRED/);
  const unprivileged=guestImports(f.module,{text:'',truncated:false});
  assert.throws(()=>unprivileged.imports.atto.actor_job_ack(0n,0n),/E_ACTOR/);
  const request={job_id:'only',target:{kind:'actor',key:k},value:3n,attempt:1n};
  f.host.jobs.dispatch_job(request);
  assert.throws(()=>f.host.jobs.dispatch_job({...request,attempt:2n}),/E_ACTOR_JOB_CONFLICT/);
  assert.throws(()=>f.host.jobs.dispatch_job({...request,correlation_id:'different'}),/E_ACTOR_JOB_CONFLICT/);
  assert.equal(await f.host.drain(),null);
  assert.equal(f.host.jobs.inspect('tenant-a','only').status,'completed');
  f.host.close();
});

test('guest ACK intent followed by a trap never commits completion', async()=>{
  const source=base('    job.ack();\n    stdio.println(job.payload * 9223372036854775807);');
  const f=fixture(source);
  const failed=f.key('bad'), good=f.key('good');
  f.host.registry.register(failed);
  const request={job_id:'ambiguous',target:{kind:'actor',key:failed},value:2n,attempt:0n};
  f.host.jobs.dispatch_job(request);
  const other=f.host.registry.register(good).ref;
  f.host.jobs.dispatch_job({job_id:'healthy',target:{kind:'actor',key:good},value:0n});
  assert.match(await f.host.drain(),/E_PANIC: integer overflow/);
  assert.equal(f.host.jobs.inspect('tenant-a','ambiguous').status,'indeterminate');
  assert.deepEqual(f.host.jobs.inspect('tenant-a','healthy'),{status:'completed',ref:other});
  assert.throws(()=>f.host.jobs.dispatch_job(request),/E_ACTOR_JOB_INDETERMINATE/);
  f.host.close();
});

test('handler return without job.ack is observed but not a completion receipt',async()=>{
  const f=fixture(base('    stdio.println(job.job_id);'));
  const k=f.key();f.host.registry.register(k);
  const q={job_id:'no-ack',target:{kind:'actor',key:k},value:8n};
  f.host.jobs.dispatch_job(q);
  assert.equal(await f.host.drain(),null);
  assert.equal(f.host.jobs.inspect('tenant-a','no-ack').status,'observed_executed');
  assert.equal(f.out.text,'no-ack\n');
  f.host.close();
});

test('mixed Job<int> and legacy ActorMail<int> preserve separate entrypoints',async()=>{
  const legacy=['define serial actor Legacy as',
    '  receive(ActorMail<int> mail): void {',
    '    stdio.println(mail.value);',
    '    return;',
    '  }','end'].join('\n');
  const f=fixture(base('    job.ack();',legacy));
  assert.deepEqual(f.modes,[true,false]);
  const k=f.key('job'),legacySlot=f.host.spawn(1);
  f.host.registry.register(k);
  const job={job_id:'real',target:{kind:'actor',key:k},value:42n};
  f.host.jobs.dispatch_job(job);
  f.host.send(legacySlot,5n);
  assert.equal(await f.host.drain(),null);
  assert.equal(f.host.jobs.inspect('tenant-a','real').status,'completed');
  assert.match(f.out.text,/5\n/);
  f.host.close();
});

test('job receive cannot run through the legacy untracked i64 entrypoint',async()=>{
  const f=fixture();
  const actor=f.host.spawn(0);
  assert.throws(()=>f.host.send(actor,1n),/E_ACTOR_JOB_REQUIRED/);
  assert.equal(f.host.stats.pendingMessages,0);
  assert.throws(()=>f.host.jobs.bind_mailbox({},actor),/E_ACTOR_JOB_CLAIM/);
  f.host.close();
});

test('high-volume 1,000 real guest jobs ACK once without identity aliasing',async()=>{
  const f=fixture(base('    job.ack();'));
  const k=f.key(),ref=f.host.registry.register(k).ref;
  for(let i=0;i<1000;i++){
    assert.equal(f.host.jobs.dispatch_job({job_id:'batch:'+i,target:{kind:'actor',key:k},
      value:BigInt(i),attempt:1n,correlation_id:'trace:'+i}).status,'admitted');
  }
  assert.equal(f.host.stats.pendingMessages,1000);
  assert.equal(await f.host.drain(),null);
  for(let i=0;i<1000;i++){
    assert.deepEqual(f.host.jobs.inspect('tenant-a','batch:'+i),{status:'completed',ref});
  }
  assert.equal(f.host.stats.pendingMessages,0);
  f.host.close();
});


test('capturing job identity in unsupported actor string state fails compilation',async()=>{
  const source=[
    'define serial actor Worker as',
    '  let string saved = "";',
    '  receive(Job<int> job): void {',
    '    if job.payload == 1 {',
    '      self.saved = job.job_id;',
    '    } else {',
    '      stdio.println(self.saved);',
    '    } fi',
    '    job.ack();',
    '    return;',
    '  }',
    'end',
    'pub fnc main(): int { return 0; }'
  ].join('\n');
  // Actor fields are deliberately scalar-only in this browser subset.
  // Persisting a borrowed job descriptor in actor state must fail at compile
  // time, rather than silently alias a later job's memory.
  const compiled=compiler.compile(source);
  assert.equal(compiled.ok,false,'actor string state is not admitted');
  assert.match(JSON.stringify(compiled.diagnostics),
    /E_UNSUPPORTED_TYPE: field 'Worker.saved'.*actor fields may be int or bool/);
});
