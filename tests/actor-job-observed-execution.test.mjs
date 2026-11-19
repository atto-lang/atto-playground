/**
 * Real compiled Atto -> Wasm actor receives; host-only correlation of mailbox
 * execution. This is NOT a guest-visible Job<T>, actor ACK or durable receipt.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createCompiler } from '../src/compiler.js';
import { actorNames } from '../src/guest.js';
import { createTenantActorHost } from '../src/tenant-actor-host.js';

const compilerBytes = await readFile(new URL('../public/atto_compiler.wasm', import.meta.url));
const compiler = await createCompiler(compilerBytes);

function compiledHost(expression = 'mail.value') {
  const source = [
    'define actor Worker as',
    '  receive(ActorMail<int> mail): void {',
    '    stdio.println(' + expression + ');',
    '    return;',
    '  }',
    'end',
    'pub fnc main(): int { return 0; }'
  ].join('\n');
  const compiled = compiler.compile(source);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.diagnostics));
  const module = new WebAssembly.Module(compiled.wasm);
  const out = { text: '', truncated: false };
  const host = createTenantActorHost({module, names: actorNames(module), out});
  const key = application_key => ({
    namespace: 'tenant-a', actor_type: 0, application_key
  });
  const group = group_name => ({
    namespace: 'tenant-a', actor_type: 0, group_name
  });
  return { host, out, key, group };
}

test('compiled Atto guest handler returns before host reports observed execution', async () => {
  const f=compiledHost(), k=f.key('orders');
  const ref=f.host.registry.register(k).ref;
  const job={job_id:'order-42',target:{kind:'actor',key:k},value:42n};
  assert.equal(f.host.jobs.inspect('tenant-a','order-42'),null);
  assert.equal(f.host.jobs.dispatch_job(job).status,'admitted');
  assert.deepEqual(f.host.jobs.inspect('tenant-a','order-42'),{status:'admitted',ref});
  assert.equal(f.out.text,'','host must not infer execution from enqueue');
  assert.equal(await f.host.drain(),null);
  assert.equal(f.out.text,'42\n');
  assert.deepEqual(f.host.jobs.inspect('tenant-a','order-42'),{status:'observed_executed',ref});
  assert.equal(f.host.jobs.dispatch_job(job).status,'duplicate');
  assert.equal(f.out.text,'42\n','duplicate does not rerun the compiled guest');
  f.host.close();
});

test('group job execution is correlated to exactly one physical actor', async () => {
  const f=compiledHost(), a=f.host.registry.register(f.key('a')).ref;
  const b=f.host.registry.register(f.key('b')).ref;
  const g=f.group('workers');
  f.host.groups.join(g,a);
  f.host.groups.join(g,b);
  const request={job_id:'assigned',target:{kind:'group',group:g},value:37n};
  const placement=f.host.jobs.dispatch_job(request);
  assert.ok([a,b].includes(placement.ref));
  assert.equal(f.host.jobs.inspect('tenant-a','assigned').status,'admitted');
  assert.equal(f.host.stats.pendingMessages,1,'group assignment never broadcasts');
  assert.equal(await f.host.drain(),null);
  assert.equal(f.out.text,'37\n');
  assert.deepEqual(f.host.jobs.inspect('tenant-a','assigned'),
    {status:'observed_executed',ref:placement.ref});
  assert.equal(f.host.jobs.dispatch_job(request).status,'duplicate');
  assert.throws(()=>f.host.jobs.dispatch_job({...request,value:38n}),/E_ACTOR_JOB_CONFLICT/);
  f.host.close();
});

test('guest Wasm trap after admission is indeterminate, not acknowledged', async () => {
  const f=compiledHost('mail.value * 9223372036854775807');
  const failing=f.key('bad'), surviving=f.key('good');
  f.host.registry.register(failing);
  const success=f.host.registry.register(surviving).ref;
  f.host.jobs.dispatch_job({job_id:'maybe-side-effect',target:{kind:'actor',key:failing},value:2n});
  f.host.jobs.dispatch_job({job_id:'healthy',target:{kind:'actor',key:surviving},value:0n});
  assert.match(await f.host.drain(),/E_PANIC: integer overflow/);
  assert.equal(f.host.jobs.inspect('tenant-a','maybe-side-effect').status,'indeterminate');
  assert.deepEqual(f.host.jobs.inspect('tenant-a','healthy'),
    {status:'observed_executed',ref:success});
  assert.throws(()=>f.host.jobs.dispatch_job({
    job_id:'maybe-side-effect',target:{kind:'actor',key:failing},value:2n
  }),/E_ACTOR_JOB_INDETERMINATE/);
  f.host.close();
});

test('retiring actor with queued job creates indeterminate outcome without executing', async () => {
  const f=compiledHost(), k=f.key('retired');
  const registration=f.host.registry.register(k);
  f.host.jobs.dispatch_job({job_id:'queued',target:{kind:'actor',key:k},value:91n});
  assert.equal(f.host.registry.unregister(k,registration.token),true);
  assert.equal(f.host.jobs.inspect('tenant-a','queued').status,'indeterminate');
  const replacement=f.host.registry.register(k);
  assert.notEqual(replacement.ref,registration.ref);
  assert.throws(()=>f.host.jobs.dispatch_job({
    job_id:'queued',target:{kind:'actor',key:k},value:91n
  }),/E_ACTOR_JOB_INDETERMINATE/);
  assert.equal(await f.host.drain(),null);
  assert.equal(f.out.text,'');
  f.host.close();
});

test('host-only admission claims are opaque and forged delivery observations fail', async () => {
  const f=compiledHost(), k=f.key('claims');
  f.host.registry.register(k);
  assert.throws(()=>f.host.jobs.bind_mailbox({},0),/E_ACTOR_JOB_CLAIM/);
  assert.throws(()=>f.host.jobs.observe_job({},0,'returned'),/E_ACTOR_JOB_CLAIM/);
  f.host.jobs.dispatch_job({job_id:'real',target:{kind:'actor',key:k},value:1n});
  assert.equal(await f.host.drain(),null);
  assert.equal(f.host.jobs.inspect('tenant-a','real').status,'observed_executed');
  f.host.close();
  assert.throws(()=>f.host.jobs.inspect('tenant-a','real'),/E_ACTOR_JOB_CLOSED/);
});

test('pinned compiler still does not claim guest-visible Job<T> identity', () => {
  const source = 'define actor W as\n' +
    '  receive(ActorMail<int> mail): void {\n' +
    '    stdio.println(mail.job_id);\n' +
    '    return;\n' +
    '  }\nend\npub fnc main(): int { return 0; }\n';
  const compiled=compiler.compile(source);
  assert.equal(compiled.ok,false,'unsupported guest-visible job ID must fail closed');
  assert.equal(compiled.wasm,undefined,'no executable artifact on unsupported ABI');
});
