'use strict';
const {randomUUID}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {problem}=require('./contract');
// Explicit, short-lived PNG screen streams. They observe only; control uses the
// independent exclusive device lease. No OCR or collection data originates here.
class DisplaySessions {
 constructor(store,{adbPath='adb',execute=promisify(execFile),now=Date.now,ttlMs=20000}={}){
  this.store=store;this.adbPath=adbPath;this.execute=execute;this.now=now;this.ttlMs=ttlMs;this.sessions=new Map();this.frames=new Map();this.pending=new Set();this.closed=false;
  this.timer=setInterval(()=>this.expire(),1000);this.timer.unref();
 }
 open(deviceId,scope){
  if(this.closed)throw problem('DISPLAY_CLOSED',503);
  const device=this.store.devices().find(d=>d.id===deviceId&&d.kind==='android');
  if(!device||!/^[-\w.:]+$/.test(device.serial||''))throw problem('ANDROID_DEVICE_REQUIRED',409);
  if(this.sessions.size>=32)throw problem('DISPLAY_CAPACITY',429);
  const id=randomUUID();this.sessions.set(id,{device,scope,expires:this.now()+this.ttlMs});return {id,expires_in_ms:this.ttlMs,format:'png',max_fps:2};
 }
 get(id,scope){const s=this.sessions.get(id);if(!s||s.scope!==scope||s.expires<=this.now())throw problem('DISPLAY_EXPIRED',410);return s;}
 async frame(id,scope){
  const s=this.get(id,scope);s.expires=this.now()+this.ttlMs;
  let frame=this.frames.get(s.device.id);
  if(!frame||(!frame.pending&&this.now()-frame.at>=500)){
   frame={at:this.now(),controller:new AbortController()};this.frames.set(s.device.id,frame);
   frame.pending=this.execute(this.adbPath,['-s',s.device.serial,'exec-out','screencap','-p'],{encoding:'buffer',timeout:10000,maxBuffer:12*1024*1024,signal:frame.controller.signal}).then(({stdout})=>{
    const bytes=Buffer.from(stdout);if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw problem('DISPLAY_INVALID_FRAME',502);
    frame.bytes=bytes;return bytes;
   }).catch(()=>{if(this.frames.get(s.device.id)===frame)this.frames.delete(s.device.id);throw problem('DISPLAY_UNAVAILABLE',503);}).finally(()=>{this.pending.delete(frame.pending);frame.pending=null;});
   this.pending.add(frame.pending);
  }
  const bytes=await (frame.pending||frame.bytes);this.get(id,scope);return bytes;
 }
 stop(id,scope){this.get(id,scope);const s=this.sessions.get(id);this.sessions.delete(id);this.clearUnused(s.device.id);return {stopped:true};}
 clearUnused(deviceId){if(![...this.sessions.values()].some(s=>s.device.id===deviceId)){this.frames.get(deviceId)?.controller.abort();this.frames.delete(deviceId);}}
 expire(){for(const [id,s]of this.sessions)if(s.expires<=this.now()){this.sessions.delete(id);this.clearUnused(s.device.id);}}
 async close(){this.closed=true;clearInterval(this.timer);this.sessions.clear();const pending=[...this.frames.values()];for(const f of pending)f.controller.abort();await Promise.allSettled([...this.pending]);this.frames.clear();}
}
module.exports={DisplaySessions};
