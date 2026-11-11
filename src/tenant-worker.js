/** Exactly one tenant run; compiler output only. Parent owns the hard deadline. */
import {runTenantGuest} from './canonical-actor-runtime.mjs';
import {actorNames,guestImports} from './guest.js';
let started=false;
self.onmessage=async({data})=>{
  if(started)return;started=true;let url;
  try{
    let guest;
    if(data.target==='wasm'){
      const bytes=new Uint8Array(data.wasm);
      if(bytes.byteLength>1<<20||!WebAssembly.validate(bytes))throw Error('E_ABI: invalid/oversized guest module');
      const module=await WebAssembly.compile(bytes);
      // Reuse the existing guest ABI import/export capability gate.
      guestImports(module,{text:'',truncated:false});
      guest={actorNames:actorNames(module),instantiate:atto=>new WebAssembly.Instance(module,{atto})};
    }else if(data.target==='javascript'){
      if(typeof data.esm!=='string'||data.esm.length>1<<20||new TextEncoder().encode(data.esm).length>1<<20)
        throw Error('E_ABI: invalid/oversized generated ESM');
      // Source text is never evaluated here; this is compiler-generated ESM.
      url=URL.createObjectURL(new Blob([data.esm],{type:'text/javascript'}));
      guest=await import(url);
    }else throw Error('E_ABI: unknown execution target');
    self.postMessage(await runTenantGuest(guest));
  }catch(error){self.postMessage({ok:false,message:String(error?.message||error).slice(0,4096),stdout:'',truncated:false,actors:0});}
  finally{if(url)URL.revokeObjectURL(url);}
};
