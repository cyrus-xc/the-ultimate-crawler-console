'use strict';
const {setTimeout: delay}=require('node:timers/promises');
const {problem}=require('./contract');

function requireOnline(transport){
 if(transport?.state==='unauthorized')throw problem('ADB_AUTHORIZATION_REQUIRED',409);
 if(transport?.state!=='device')throw problem('PHONE_RECONNECT_FAILED',409);
}

const {verifyPhoneIdle}=require('./phone_idle');
const {PhoneRecoveryLog}=require('./phone_recovery_log');

class ConnectionRecovery {
 constructor(store,gateway,inventory,{hasDisplay=()=>false,pollMs=1000,retryMs=60000,waitMs=800,attempts=24,sleep=delay,verifyIdle=serial=>verifyPhoneIdle(serial,{adbPath:gateway.adbPath})}={}){
  Object.assign(this,{store,gateway,inventory,hasDisplay,pollMs,retryMs,waitMs,attempts,sleep,verifyIdle});
  this.log=new PhoneRecoveryLog(store);
  this.pending=new Map();
  this.lastAttempt=new Map();
  this.closed=false;
 }
 isRepairing(id){return this.pending.has(id);}
 repair(id,{manual=true}={}){
  if(this.closed)return Promise.reject(problem('CONNECTION_REPAIR_UNAVAILABLE',503));
  const active=this.pending.get(id);
  if(active)return active;
  const work=this.attempt(id,manual).finally(()=>this.pending.delete(id));
  this.pending.set(id,work);
  return work;
 }
 async attempt(id,manual){
  const device=this.store.devices().find(d=>d.id===id&&d.kind==='android');
  if(!device)throw problem('ANDROID_DEVICE_REQUIRED',404);
  const schedule=device.quarantined?this.log.schedule(id):null;
  const entry=this.log.start(id,manual,schedule);
  try{return await this.reconnect(device,manual,schedule);}
  catch(error){
   const code=/^[A-Z][A-Z0-9_]{0,70}$/.test(error.code)?error.code:'CONNECTION_REPAIR_FAILED';
   this.log.failed(entry,code,this.offlineRetry(device));
   throw problem(code,error.status||409);
  }
 }
 offlineRetry(device){
  const last=this.lastAttempt.get(device.id);
  return this.inventory.snapshot?.get(device.serial)?.state==='offline' && last!==undefined ? last+this.retryMs : null;
 }
 describe(device){
  return this.log.view(device,this.isRepairing(device.id),this.offlineRetry(device));
 }
 async reconnect(device,manual,schedule){
  const id=device.id;
  if(this.hasDisplay(id))throw problem('DEVICE_BUSY',409);
  this.gateway.beforeCommand();
  if(schedule && this.store.db.prepare("SELECT 1 FROM attempts WHERE device_id=? AND finished IS NULL").get(id))throw problem('DEVICE_BUSY',409);
  const lease=this.store.externalLease(id,'local:connection-repair',{connectionRepair:true});
  let verified=false;
  try{
   let transport=await this.readTransport(device.serial);
   if(!transport)throw problem('PHONE_NOT_DETECTED',409);
   if(transport.state==='unauthorized')throw problem('ADB_AUTHORIZATION_REQUIRED',409);
   if(!['device','offline'].includes(transport.state))throw problem('PHONE_CONNECTION_UNAVAILABLE',409);
   if(transport.state==='offline'){
    this.lastAttempt.set(id,this.store.now());
    try{
     await this.gateway.executeTrusted(lease,{serial:device.serial,args:['reconnect']},{timeoutMs:3500,cleanup:!!schedule});
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
   requireOnline(transport);
   this.store.heartbeat(lease);
   if(schedule){
    try{await this.verifyIdle(device.serial);}
    catch(error){throw problem(/^PHONE_[A-Z_]+$/.test(error.code)?error.code:'PHONE_IDLE_CHECK_FAILED',409);}
   }
   // A phone left unavailable by a UI-observation failure (first page, next
   // page, blocking overlay) returns to service only after its recorded
   // incident is confirmed and the phone is proven idle.
   if(manual&&!schedule&&device.health==='unavailable'){
    const failure=this.store.profileFailureForRepair(id);
    if(failure){
     let idle=false;
     try{await this.verifyIdle(device.serial);idle=true;}catch{/* An incomplete probe cannot restore health. */}
     if(idle&&!this.closed){
      requireOnline(await this.readTransport(device.serial));
      this.store.heartbeat(lease);
      this.gateway.beforeCommand();
      if(!this.hasDisplay(id)&&!this.gateway.recoveryFaults.has(id))this.store.restoreProfileFailure(lease,failure.seq);
     }
    }
   }
   await this.gateway.drain(lease);
   this.store.tx(()=>{
    this.gateway.beforeCommand();
    const current=this.store.devices().find(d=>d.id===id);
    if(this.closed || this.hasDisplay(id) || (!!current.quarantined!==!!schedule) ||
       (schedule && this.log.schedule(id).incident!==schedule.incident))throw problem('RECOVERY_SUPERSEDED',409);
    this.store.releaseExternal(lease);
    if(schedule)this.gateway.recoverDevice(id,{stopped:true});
    const healthy=(!!schedule||current.health==='ready') && !Object.keys(current.faults).length;
    this.store.event(null,'device.connection_verified',{device_id:id,manual,healthy});
   });
   verified=true;
  }finally{
   if(!verified){
    await this.gateway.drain(lease);
    this.store.releaseExternal(lease);
   }
  }
  const current=this.store.devices().find(d=>d.id===id);
  return {connection_state:'device',health:current.health,capabilities:current.capabilities.length};
 }
 async readTransport(serial){
  const found=await this.inventory.refresh();
  if(this.inventory.lastError)throw problem(this.inventory.lastError,503);
  return found.find(item=>item.serial===serial);
 }
 tick(){
  if(this.closed)return;
  for(const device of this.store.devices()){
   if(device.kind!=='android'||this.isRepairing(device.id))continue;
   if(device.quarantined){
    if(this.store.now()>=this.log.schedule(device.id).next)this.repair(device.id,{manual:false}).catch(()=>{});
    continue;
   }
   if(device.owner||this.inventory.snapshot?.get(device.serial)?.state!=='offline')continue;
   if(this.store.now()-(this.lastAttempt.get(device.id)??-Infinity)<this.retryMs)continue;
   this.lastAttempt.set(device.id,this.store.now());
   this.repair(device.id,{manual:false}).catch(()=>{});
  }
 }
 start(){
  this.timer=setInterval(()=>this.tick(),this.pollMs);
  this.timer.unref();this.tick();
  return this;
 }
 async close(){
  this.closed=true;
  clearInterval(this.timer);
  await Promise.allSettled(this.pending.values());
 }
}
module.exports={ConnectionRecovery};
