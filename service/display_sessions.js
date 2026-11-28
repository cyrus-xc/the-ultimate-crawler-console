'use strict';
const {randomUUID}=require('node:crypto');
const {problem}=require('./contract');
const {startVideo,touchMessage}=require('./scrcpy_video');
const {execFile}=require('node:child_process');
const MAX_PACKET=12*1024*1024;
class DisplaySessions {
 constructor(store,{adbPath='adb',start=startVideo,now=Date.now,ttlMs=20000,needsRoot=null}={}){
  Object.assign(this,{store,adbPath,start,now,ttlMs});this.needsRoot=needsRoot||(async()=>false);this.rootCache=new Map();this.gestures=new Map();this.sessions=new Map();this.encoders=new Map();this.pending=new Set();this.draining=new Map();this.closed=false;
  this.timer=setInterval(()=>this.expire(),1000);this.timer.unref();
 }
 usesDevice(id){
  return this.encoders.has(id)||this.draining.has(id)||[...this.sessions.values()].some(s=>s.device.id===id&&s.expires>this.now());
 }
 open(deviceId,scope){
  if(this.closed)throw problem('DISPLAY_CLOSED',503);
  const device=this.store.devices().find(d=>d.id===deviceId&&d.kind==='android');
  if(!device||!/^[-\w.:]+$/.test(device.serial||''))throw problem('ANDROID_DEVICE_REQUIRED',409);
  if(this.sessions.size>=32)throw problem('DISPLAY_CAPACITY',429);
  const id=randomUUID();this.sessions.set(id,{device,scope,expires:this.now()+this.ttlMs});return {id,expires_in_ms:this.ttlMs,format:'scrcpy-h264',max_fps:30};
 }
 get(id,scope){const s=this.sessions.get(id);if(!s||s.scope!==scope||s.expires<=this.now())throw problem('DISPLAY_EXPIRED',410);return s;}
 async stream(id,scope,res){
  const s=this.get(id,scope);if(s.response)throw problem('DISPLAY_ALREADY_CONNECTED',409);
  s.response=res;s.waitKey=true;s.expires=this.now()+this.ttlMs;
  res.once('close',()=>this.remove(id));
  let encoder=this.encoders.get(s.device.id);
  if(!encoder){
   encoder={controller:new AbortController(),buffer:Buffer.alloc(0)};this.encoders.set(s.device.id,encoder);
   encoder.ready=Promise.resolve(this.draining.get(s.device.id)).then(()=>this.startControlled(s.device.serial,encoder.controller.signal)).then(transport=>{
    encoder.transport=transport;
    if(encoder.controller.signal.aborted){this.track(transport.close());return;}
    transport.stream.on('data',chunk=>{try{this.consume(s.device.id,encoder,chunk);}catch{this.fail(s.device.id,encoder);}});
    transport.stream.on('error',()=>this.fail(s.device.id,encoder));transport.stream.on('end',()=>this.fail(s.device.id,encoder));transport.stream.on('close',()=>this.fail(s.device.id,encoder));
   }).catch(error=>{if(this.encoders.get(s.device.id)===encoder)for(const [key,viewer]of this.sessions)if(viewer.device.id===s.device.id)this.remove(key,false);throw error;});
  }
  await encoder.ready;
  if(this.sessions.get(id)!==s||res.destroyed) return;
  if(!res.headersSent){res.setHeader('Content-Type','application/octet-stream');res.setHeader('X-Accel-Buffering','no');}
  // Headers are also set lazily in send() if encoder output won the startup race.
  if(encoder.meta&&!s.metaSent)this.send(s,encoder.meta,true);
 }
 send(s,bytes,meta=false){
  const res=s.response;if(!res||res.destroyed)return;
  if(!res.headersSent){res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','no-store');res.setHeader('X-Accel-Buffering','no');}
  if(meta)s.metaSent=true;
  res.write(bytes);if(res.writableLength>2*1024*1024)res.destroy(); // Bound lagging viewers; never stall another viewer or buffer indefinitely.
 }
 consume(deviceId,e,chunk){
  e.buffer=Buffer.concat([e.buffer,chunk]);
  if(!e.meta){if(e.buffer.length<12)return;e.meta=e.buffer.subarray(0,12);e.buffer=e.buffer.subarray(12);if(e.meta.readUInt32BE(0)!==0x68323634)throw Error('codec');}
  for(const s of this.sessions.values())if(s.device.id===deviceId&&s.response&&!s.metaSent)this.send(s,e.meta,true);
  while(e.buffer.length>=12){
   const size=e.buffer.readUInt32BE(8);if(size>MAX_PACKET)throw Error('packet');if(e.buffer.length<12+size)return;
   const packet=e.buffer.subarray(0,12+size);e.buffer=e.buffer.subarray(12+size);
   const config=!!(packet[0]&128),key=!!(packet[0]&64);if(config)e.config=packet;
   for(const s of this.sessions.values()){
    if(s.device.id!==deviceId||!s.response)continue;
    if(config){s.waitKey=true;continue;}
    if(s.waitKey){if(!key||!e.config)continue;this.send(s,e.config);s.waitKey=false;}
    this.send(s,packet);
   }
  }
 }
 // Live touch needs the server's control socket; a phone whose shell user may
 // not inject input runs it as root. Without control the video still works.
 async startControlled(serial,signal){
  if(!this.rootCache.has(serial))this.rootCache.set(serial,await this.needsRoot(serial).catch(()=>false));
  try{return await this.start(serial,{adbPath:this.adbPath,signal,control:true,root:this.rootCache.get(serial)});}
  catch(error){if(signal.aborted)throw error;this.rootCache.delete(serial);return this.start(serial,{adbPath:this.adbPath,signal});}
 }
 // events: [{a:'down'|'move'|'up',x,y,t}] with x/y in 0..1 of the screen and t
 // in client ms. Timing inside a gesture is kept; late batches play at once.
 touch(deviceId,events){
  const e=this.encoders.get(deviceId),control=e?.transport?.control;
  if(!e?.meta)throw problem('DISPLAY_REQUIRED',409);
  if(!control||control.destroyed)throw problem('TOUCH_UNAVAILABLE',409);
  if(!Array.isArray(events)||!events.length||events.length>240||!events.every(v=>v&&['down','move','up'].includes(v.a)&&[v.x,v.y].every(n=>typeof n==='number'&&n>=0&&n<=1)&&Number.isFinite(v.t)))throw problem('INVALID_TOUCH',400);
  const width=e.meta.readUInt32BE(4),height=e.meta.readUInt32BE(8),now=this.now();
  let g=this.gestures.get(deviceId);
  for(const v of events){
   if(v.a==='down'||!g)g={base:now+40-v.t};
   const at=Math.max(0,g.base+v.t-this.now()),message=touchMessage(v.a,Math.round(v.x*(width-1)),Math.round(v.y*(height-1)),width,height);
   setTimeout(()=>{if(!control.destroyed)control.write(message);},Math.min(at,2000)).unref?.();
   if(v.a==='up'){this.gestures.delete(deviceId);g=null;}else this.gestures.set(deviceId,g);
  }
  return {accepted:events.length};
 }
 track(promise){this.pending.add(promise);promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise;}
 remove(id,destroy=true){const s=this.sessions.get(id);if(!s)return;this.sessions.delete(id);if(destroy)s.response?.destroy();
  if(![...this.sessions.values()].some(other=>other.device.id===s.device.id&&other.response)){
   const e=this.encoders.get(s.device.id);if(e){this.encoders.delete(s.device.id);e.controller.abort();const drain=this.track(e.ready.catch(()=>{}).then(()=>e.transport?.close()));this.draining.set(s.device.id,drain);drain.finally(()=>{if(this.draining.get(s.device.id)===drain)this.draining.delete(s.device.id);}).catch(()=>{});}
  }
 }
 fail(deviceId,encoder){if(this.encoders.get(deviceId)!==encoder)return;for(const [id,s]of this.sessions)if(s.device.id===deviceId)this.remove(id);}
 heartbeat(id,scope){const s=this.get(id,scope);s.expires=this.now()+this.ttlMs;return {expires_in_ms:this.ttlMs};}
 stop(id,scope){this.get(id,scope);this.remove(id);return {stopped:true};}
 expire(){for(const [id,s]of this.sessions)if(s.expires<=this.now())this.remove(id);}
 async close(){this.closed=true;clearInterval(this.timer);for(const id of this.sessions.keys())this.remove(id);await Promise.allSettled([...this.pending]);}
}
// True when the shell user may not inject input but su works (e.g. MIUI).
function rootForInput(adbPath,serial){
 const run=args=>new Promise(resolve=>execFile(adbPath,['-s',serial,'shell',...args],{timeout:8000},(error,stdout,stderr)=>resolve(String(stdout)+String(stderr))));
 return run(['input','keyevent','0']).then(async out=>/INJECT_EVENTS|SecurityException/.test(out)&&/uid=0\(/.test(await run(['su','-c','id'])));
}
module.exports={DisplaySessions,rootForInput};
