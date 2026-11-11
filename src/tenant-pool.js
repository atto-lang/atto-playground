import {createWorkerTask} from './worker-task.js';
export const MAX_BROWSER_TENANTS=4;
/** Own one disposable Worker for each active tenant execution. */
export function createTenantPool({WorkerImpl=globalThis.Worker}={}){
  const active=new Map();let closed=false;
  return Object.freeze({
    run(tenantId,payload,deadlineMs=3000){
      if(closed)throw Error('E_TENANT_CLOSED: pool closed');
      if(typeof tenantId!=='string'||! /^[A-Za-z0-9_-]{1,64}$/.test(tenantId))throw Error('E_TENANT: invalid tenant id');
      if(active.has(tenantId))throw Error('E_TENANT_BUSY: tenant already executing');
      if(active.size>=MAX_BROWSER_TENANTS)throw Error('E_TENANT_LIMIT: too many active tenants');
      const task=createWorkerTask({WorkerImpl});active.set(tenantId,task);
      let promise;
      try{promise=task.request(new URL('./tenant-worker.js',import.meta.url),payload,deadlineMs,'Execution');}
      catch(error){active.delete(tenantId);throw error;}
      return promise.finally(()=>{if(active.get(tenantId)===task)active.delete(tenantId);});
    },
    cancel(tenantId){return active.get(tenantId)?.cancel()??false;},
    close(){closed=true;for(const task of active.values())task.cancel();},
    get count(){return active.size;}
  });
}
