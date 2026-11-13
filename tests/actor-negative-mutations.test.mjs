// Negative mutation evidence: the same invariants pass on production code
// and MUST fail after a precise, controlled security-check removal.
// Mutated modules are created in OS tempdir, never committed or deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createActorHost} from '../src/actor-host.js';

const source = await readFile(new URL('../src/actor-host.js',import.meta.url),'utf8');
const guestURL = new URL('../src/guest.js',import.meta.url).href;
const asStandalone = src => src.replace(
  "from './guest.js'", "from '" + guestURL + "'");
const mutations = [
  {
    label:'missing generation gate',
    needle:'if (data?.generation !== a.generation) return;',
    replacement:'if (false /* mutated away generation fence */) return;',
  },
  {
    label:'missing sequence gate',
    needle:'data.sequence !== a.done',
    replacement:'false /* mutated away sequence fence */',
  },
  {
    label:'missing ready gate',
    needle:'!a.ready || !Number.isSafeInteger(data.sequence)',
    replacement:'false /* mutated away ready fence */ || !Number.isSafeInteger(data.sequence)',
  },
];

async function securityProbe(factory,mutation) {
  class ManualWorker {
    static latest;
    constructor(){this.posts=[];ManualWorker.latest=this;}
    postMessage(m){this.posts.push(m);}
    terminate(){}
    emit(data){this.onmessage?.({data});}
  }
  const out={text:'',truncated:false};
  const host=factory({wasm:new Uint8Array([0,97,115,109,1,0,0,0]),
    names:['Counter'],out,WorkerImpl:ManualWorker,workerUrl:'mock'});
  const ref=host.spawn(0),w=ManualWorker.latest,generation=w.posts[0].generation;
  host.send(ref,42n);
  if(mutation === 'missing generation gate'){
    w.emit({kind:'ready',generation});
    w.emit({kind:'done',generation:generation-1,sequence:0,stdout:'POISON\\n'});
    w.emit({kind:'done',generation,sequence:0,stdout:'SAFE\\n'});
    const fault=await host.drain();
    host.close();
    return fault===null && out.text==='SAFE\\n';
  }
  if(mutation === 'missing ready gate'){
    w.emit({kind:'done',generation,sequence:0,stdout:'POISON\\n'});
    // The mutant waits for ready even after admitting a forged pre-ready
    // completion. Send ready to distinguish false success from pending drain.
    w.emit({kind:'ready',generation});
  } else {
    w.emit({kind:'ready',generation});
    w.emit({kind:'done',generation,sequence:999,stdout:'POISON\\n'});
  }
  const fault=await host.drain();
  host.close();
  return /^E_ACTOR_PROTOCOL: /.test(fault||'') && out.text==='';
}

test('three protocol-fencing mutants are killed by the unmodified invariant probes',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'atto-actor-mutants-'));
  try {
    for (let i=0;i<mutations.length;i++){
      const m=mutations[i];
      assert.equal(source.split(m.needle).length-1,1, 'mutation anchor must stay unique: '+m.label);
      assert.equal(await securityProbe(createActorHost,m.label),true,'baseline invariant: '+m.label);
      const altered=asStandalone(source.replace(m.needle,m.replacement));
      const location=join(folder,'actor-host-mutant-'+i+'.mjs');
      await writeFile(location,altered);
      const mutant=(await import(pathToFileURL(location).href)).createActorHost;
      assert.equal(await securityProbe(mutant,m.label),false,
        'surviving mutant: '+m.label);
      console.log('MUTATION KILLED: '+m.label);
    }
  } finally {
    await rm(folder,{recursive:true,force:true});
  }
});
