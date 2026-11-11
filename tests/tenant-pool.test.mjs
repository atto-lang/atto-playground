import test from 'node:test';import assert from 'node:assert/strict';
import {createTenantPool,MAX_BROWSER_TENANTS} from '../src/tenant-pool.js';
class Worker {
 static all=[];
 constructor(url){this.url=url;this.terminated=0;Worker.all.push(this);}
 postMessage(payload){this.payload=payload;}
 terminate(){this.terminated++;}
 reply(value){this.onmessage?.({data:value});}
}
test('one Worker per tenant, cancellation cannot settle a sibling tenant',async()=>{
 Worker.all=[];const pool=createTenantPool({WorkerImpl:Worker});
 const a=pool.run('a',{target:'wasm'}),b=pool.run('b',{target:'javascript'});
 assert.equal(pool.count,2);assert.equal(Worker.all.length,2);
 const old=Worker.all[0].onmessage;
 assert.equal(pool.cancel('a'),true);await assert.rejects(a,/cancelled/);
 assert.equal(Worker.all[0].terminated,1);assert.equal(Worker.all[1].terminated,0);assert.equal(pool.count,1);
 old({data:{ok:true,value:'stale'}});
 Worker.all[1].reply({ok:true,value:'42'});assert.deepEqual(await b,{ok:true,value:'42'});
 assert.equal(pool.count,0);assert.equal(Worker.all[1].terminated,1);pool.close();
});
test('busy and tenant-count limits reject before creating another Worker',async()=>{
 Worker.all=[];const pool=createTenantPool({WorkerImpl:Worker});
 const all=Array.from({length:MAX_BROWSER_TENANTS},(_,i)=>pool.run('t'+i,{}));
 assert.throws(()=>pool.run('t0',{}),/E_TENANT_BUSY/);
 assert.throws(()=>pool.run('extra',{}),/E_TENANT_LIMIT/);
 assert.equal(Worker.all.length,MAX_BROWSER_TENANTS);
 pool.close();for(const p of all)await assert.rejects(p,/cancelled/);
 assert.equal(pool.count,0);assert.throws(()=>pool.run('later',{}),/E_TENANT_CLOSED/);
});
test('failed Worker construction releases admission for the tenant',async()=>{
 class Broken {constructor(){throw Error('no Worker');}}
 const pool=createTenantPool({WorkerImpl:Broken});await assert.rejects(pool.run('a',{}),/no Worker/);
 assert.equal(pool.count,0);await assert.rejects(pool.run('a',{}),/no Worker/);pool.close();
});
