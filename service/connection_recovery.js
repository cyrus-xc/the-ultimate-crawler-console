'use strict';
const {setTimeout: delay}=require('node:timers/promises');
const {problem}=require('./contract');

class ConnectionRecovery {
 constructor(store,gateway,inventory,{hasDisplay=()=>false,pollMs=5000,retryMs=60000,waitMs=800,attempts=24,sleep=delay}={}){
  Object.assign(this,{store,gateway,inventory,hasDisplay,pollMs,retryMs,waitMs,attempts,sleep});
  this.pending=new Map();
  this.lastAttempt=new Map();
  this.closed=false;
 }
 isRepairing(id){return this.pending.has(id);}
 repair(id,{manual=true}={}){
  if(this.closed)return Promise.reject(problem('CONNECTION_REPAIR_UNAVAILABLE',503));
  const active=this.pending.get(id);
  if(active)return active;
  const work=this.reconnect(id,manual).finally(()=>this.pending.delete(id));
  this.pending.set(id,work);
  return work;
 }
 async reconnect(id,manual){
  const device=this.store.devices().find(d=>d.id===id&&d.kind==='android');
  if(!device)throw problem('ANDROID_DEVICE_REQUIRED',404);
  if(device.quarantined)throw problem('DEVICE_RECOVERY_REQUIRED',409);
  if(this.hasDisplay(id))throw problem('DEVICE_BUSY',409);
  this.gateway.beforeCommand();
  const lease=this.store.externalLease(id,'local:connection-repair',{connectionRepair:true});
  try{
   let transport=await this.readTransport(device.serial);
   if(!transport)throw problem('PHONE_NOT_DETECTED',409);
   if(transport.state==='unauthorized')throw problem('ADB_AUTHORIZATION_REQUIRED',409);
   if(!['device','offline'].includes(transport.state))throw problem('PHONE_CONNECTION_UNAVAILABLE',409);
   if(transport.state==='offline'){
    this.lastAttempt.set(id,this.store.now());
    try{
     await this.gateway.executeTrusted(lease,{serial:device.serial,args:['reconnect']},{timeoutMs:3500});
    }catch(error){
     // The transport can disappear after inventory but before the ADB command.
     // Recheck the connection without retrying an uncertain command.
     if(error.code!=='ADB_COMMAND_FAILED')throw error;
    }
    const deadline=performance.now()+20000;
    for(let attempt=0;attempt<this.attempts&&performance.now()<deadline;attempt++){
     this.store.heartbeat(lease);
     await this.sleep(this.waitMs);
     transport=await this.readTransport(device.serial);
     if(transport?.state==='device'||transport?.state==='unauthorized')break;
    }
   }
   if(transport?.state==='unauthorized')throw problem('ADB_AUTHORIZATION_REQUIRED',409);
   if(transport?.state!=='device')throw problem('PHONE_RECONNECT_FAILED',409);
   this.store.assertLease(lease);
   const current=this.store.devices().find(d=>d.id===id);
   this.store.event(null,'device.connection_verified',{device_id:id,manual});
   return {connection_state:'device',health:current.health,capabilities:current.capabilities.length};
  }finally{
   await this.gateway.drain(lease);
   this.store.releaseExternal(lease);
  }
 }
 async readTransport(serial){
  const found=await this.inventory.refresh();
  if(this.inventory.lastError)throw problem(this.inventory.lastError,503);
  return found.find(item=>item.serial===serial);
 }
 tick(){
  if(this.closed||!this.inventory.snapshot)return;
  for(const device of this.store.devices()){
   if(device.kind!=='android'||device.owner||device.quarantined||this.inventory.snapshot.get(device.serial)?.state!=='offline')continue;
   if(this.store.now()-(this.lastAttempt.get(device.id)??-Infinity)<this.retryMs)continue;
   this.repair(device.id,{manual:false}).catch(()=>{});
  }
 }
 start(){
  this.timer=setInterval(()=>this.tick(),this.pollMs);
  this.timer.unref();
  return this;
 }
 async close(){
  this.closed=true;
  clearInterval(this.timer);
  await Promise.allSettled(this.pending.values());
 }
}
module.exports={ConnectionRecovery};
