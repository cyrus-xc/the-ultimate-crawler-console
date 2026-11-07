'use strict';
const {execFile}=require('node:child_process');const {promisify}=require('node:util');
const run=promisify(execFile);
function parseDevices(stdout){
 return String(stdout).split(/\r?\n/).slice(1).map(line=>line.trim().split(/\s+/)).filter(parts=>parts.length>1&&/^[\w.:-]+$/.test(parts[0])).map(([serial,state,...rest])=>({serial,state,model:rest.find(x=>x.startsWith('model:'))?.slice(6)||serial}));
}
class DeviceInventory {
 constructor(store,{adbPath=process.env.ADB_PATH||'adb',execute=run,pollMs=5000,onError=()=>{}}={}){this.store=store;this.adbPath=adbPath;this.execute=execute;this.pollMs=pollMs;this.onError=onError;this.timer=null;this.pending=null;this.closed=false;this.lastError=null;this.snapshot=null;}
 refresh(){
  if(this.closed)return Promise.resolve([]);if(this.pending)return this.pending;
  this.pending=this.scan().finally(()=>{this.pending=null;});return this.pending;
 }
 async scan(){
  let found;
  try{const result=await this.execute(this.adbPath,['devices','-l'],{timeout:5000,maxBuffer:256*1024,windowsHide:true});found=parseDevices(result.stdout);}
  catch{this.lastError='ADB_DISCOVERY_UNAVAILABLE';this.onError(this.lastError);return [];}
  const known=this.store.devices().filter(d=>d.kind==='android'),ready=new Set(found.filter(d=>d.state==='device').map(d=>d.serial));
  for(const item of found){
   if(item.state!=='device')continue;
   const prior=known.find(d=>d.serial===item.serial);
   if(prior)this.store.setPresence(prior.id,true);
   else this.store.register({id:'android:'+item.serial,serial:item.serial,kind:'android',capabilities:[]});
  }
  for(const device of known)if(!ready.has(device.serial))this.store.setPresence(device.id,false);
  this.lastError=null;this.snapshot=new Map(found.map(d=>[d.serial,d]));return found;
 }
 describe(device){return device.kind==='android'?{...device,connection_state:this.snapshot&&!this.lastError?(this.snapshot.get(device.serial)?.state||'offline'):'unknown'}:device;}
 start(){if(this.timer)return this;this.closed=false;const tick=()=>{this.refresh().catch(()=>{this.lastError='DEVICE_DISCOVERY_FAILED';this.onError(this.lastError);});};tick();this.timer=setInterval(tick,this.pollMs);this.timer.unref();return this;}
 async close(){this.closed=true;clearInterval(this.timer);this.timer=null;if(this.pending)await this.pending;}
}
module.exports={DeviceInventory,parseDevices};
