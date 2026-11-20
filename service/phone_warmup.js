'use strict';
const {setTimeout: sleep}=require('node:timers/promises');
const {problem}=require('./contract');

const HOUR=3600000, DAY=24*HOUR, OFFSET=8*HOUR;
const localDay=now=>Math.floor((now+OFFSET)/DAY)*DAY-OFFSET;
const OWNER='local:phone-warmup';
const accountFaults=new Set(['ACCOUNT_REQUIRED','LOGIN_REQUIRED','VERIFICATION_REQUIRED','XHS_ACCESS_RESTRICTED']);
const readyStates=new Set(['queued','running','paused']);
const warmupFault=code=>problem(code,409);

class PhoneWarmup {
 constructor(store,gateway,{browse,random=Math.random,wait=sleep,now=store.now,activeNow=()=>performance.now(),onError=()=>{}}={}){
  Object.assign(this,{store,gateway,browse,random,wait,now,activeNow,onError});
  this.active=new Map();this.handoff=new Map();this.closing=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS phone_warmup (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    day INTEGER NOT NULL, starts_at INTEGER NOT NULL, stops_at INTEGER NOT NULL,
    target_ms INTEGER NOT NULL, elapsed_ms INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL, error TEXT, manual INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id,day)
  )`);
  if(!store.db.pragma('table_info(phone_warmup)').some(column=>column.name==='manual')){
   store.db.exec('ALTER TABLE phone_warmup ADD COLUMN manual INTEGER NOT NULL DEFAULT 0');
  }
  store.db.prepare("UPDATE phone_warmup SET state='paused' WHERE state='running'").run();
 }
 eligible(device){return device?.kind==='android'&&device.capabilities.some(c=>c.platform==='xiaohongshu');}
 available(device,row){return device.health==='ready'&&!device.quarantined&&(row.manual||!device.faults.xiaohongshu);}
 plan(deviceId,day){
  if(this.store.db.prepare("SELECT 1 FROM phone_warmup WHERE device_id=? AND day=?").get(deviceId,day))return;
  this.store.db.prepare(`INSERT OR IGNORE INTO phone_warmup(device_id,day,starts_at,stops_at,target_ms,state)
    VALUES(?,?,?,?,?,'scheduled')`).run(deviceId,day,day+13*HOUR+Math.floor(this.random()*7*HOUR),
     day+DAY+Math.floor(this.random()*HOUR),3*HOUR+Math.floor(this.random()*HOUR));
 }
 latest(deviceId){
  const now=this.now();
  return this.store.db.prepare(`SELECT starts_at,stops_at,target_ms,elapsed_ms,state,error,day,manual FROM phone_warmup
    WHERE device_id=? ORDER BY CASE WHEN state IN ('queued','running','paused') AND stops_at>? THEN 0
      WHEN day=? THEN 1 ELSE 2 END, day DESC LIMIT 1`).get(deviceId,now,localDay(now))||null;
 }
 view(device){return this.eligible(device)?{enabled:true,...this.latest(device.id)}:null;}
 change(id,enable){
  const device=this.store.devices().find(d=>d.id===id);
  if(!this.eligible(device))throw problem('WARMUP_PHONE_REQUIRED',404);
  if(enable&&this.active.get(id)?.controller.signal.aborted)throw warmupFault('WARMUP_STOPPING');
  const now=this.now(), day=localDay(now);
  this.store.tx(()=>{
   this.plan(id,day);
   const row=this.latest(id);
   if(enable&&readyStates.has(row.state)&&now<row.stops_at){
    this.store.db.prepare('UPDATE phone_warmup SET manual=1 WHERE device_id=? AND day=?').run(id,row.day);
   }else if(enable){
    this.store.db.prepare(`UPDATE phone_warmup SET state='queued',starts_at=?,target_ms=?,elapsed_ms=0,error=NULL,manual=1
      WHERE device_id=? AND day=?`).run(now,3*HOUR+Math.floor(this.random()*HOUR),id,day);
   }
   if(!enable)this.store.db.prepare(`UPDATE phone_warmup SET state='stopped',error=NULL
      WHERE device_id=? AND day=?`).run(id,row.day);
  });
  if(!enable)this.active.get(id)?.controller.abort(warmupFault('WARMUP_STOPPED'));
  return this.view(device);
 }
 waiting(device){
  return this.store.db.prepare(`SELECT r.payload FROM requests r
    WHERE r.state IN ('queued','running','waiting_resources')
      AND EXISTS (SELECT 1 FROM units u WHERE u.request_id=r.id AND u.state='queued')`).all().some(row=>{
    const payload=JSON.parse(row.payload);
    return this.store.compatible(device,payload)&&this.store.healthy(device,payload);
  });
 }
 async yieldDevice(id){
  if(!this.active.has(id))return;
  this.handoff.set(id,this.now()+1000);
  const task=this.active.get(id);
  task.controller.abort(warmupFault('WARMUP_PREEMPTED'));
  await task.done;
 }
 tick(){
  if(this.closing)return;
  const now=this.now(),day=localDay(now);
  for(const device of this.store.devices().filter(d=>this.eligible(d))){
   const id=device.id;
   this.plan(id,day);
   this.store.db.prepare(`UPDATE phone_warmup SET state='expired'
    WHERE device_id=? AND stops_at<=? AND state IN ('scheduled','queued','running','paused')`).run(id,now);
   this.store.db.prepare(`UPDATE phone_warmup SET state=?
     WHERE device_id=? AND day=? AND state='scheduled' AND starts_at<=?`)
    .run(now<day+20*HOUR?'queued':'expired',id,day,now);
   const task=this.active.get(id),row=this.latest(id);
   if(task){
    const reason=task.day!==row.day||!readyStates.has(row.state)?'WARMUP_STOPPED':
     !this.available(device,row)?'WARMUP_PHONE_UNAVAILABLE':
     this.waiting(device)?'WARMUP_PREEMPTED':null;
    if(reason)task.controller.abort(warmupFault(reason));
    else try{task.guard();}catch(error){task.controller.abort(error);}
    continue;
   }
   if((this.handoff.get(id)||0)<=now)this.handoff.delete(id);
   if(!readyStates.has(row.state)||device.owner||this.handoff.has(id)||!this.available(device,row)||this.waiting(device))continue;
   this.run(device,row);
  }
 }
 run(device,row){
  const id=device.id;
  let lease;
  try{lease=this.store.externalLease(id,OWNER);}catch{return;}
  const controller=new AbortController(), {signal}=controller;
  const update=this.store.db.prepare(`UPDATE phone_warmup SET state=?,error=? WHERE device_id=? AND day=? AND state IN ('queued','running','paused')`);
  update.run('running',null,id,row.day);
  let activeAt=this.activeNow(), wallAt=this.now();
  const save=this.store.db.prepare(`UPDATE phone_warmup SET elapsed_ms=min(target_ms,elapsed_ms+?)
    WHERE device_id=? AND day=? AND state IN ('running','stopped','expired')`);
  const sampleTime=()=>({active:this.activeNow(),wall:this.now()});
  const checkpoint=({active,wall}=sampleTime())=>{
   const elapsed=Math.max(0,Math.floor(Math.min(active-activeAt,row.stops_at-wallAt,row.target_ms-row.elapsed_ms)));
   if(!elapsed)return;
   save.run(elapsed,id,row.day);
   row.elapsed_ms+=elapsed;
   activeAt=active;wallAt=wall;
  };
  let abortedAt;
  signal.addEventListener('abort',()=>{abortedAt=sampleTime();},{once:true});
  const guard=()=>{
   if(signal.aborted)throw signal.reason;
   checkpoint();
   if(row.elapsed_ms>=row.target_ms)throw warmupFault('WARMUP_COMPLETED');
   if(this.now()>=row.stops_at)throw warmupFault('WARMUP_EXPIRED');
   this.store.assertLease(lease,{owner:OWNER,externalOnly:true});
  };
  const dwell=async ms=>{
   guard();
   await this.wait(ms,undefined,{signal});
   guard();
  };
  const heartbeat=setInterval(()=>{try{guard();this.store.heartbeat(lease);}catch(e){controller.abort(e);}},Math.max(10,Math.floor(this.store.leaseMs/3)));
  heartbeat.unref();
  const task={day:row.day,controller,guard};
  this.active.set(id,task);
  task.done=(async()=>{
   try{
    await this.browse({device,lease,guard,signal,dwell,random:this.random});
    throw warmupFault('WARMUP_BROWSE_ENDED');
   }catch(error){
    checkpoint(abortedAt);
    const code=(signal.aborted?signal.reason:error)?.code;
    const state=code==='WARMUP_COMPLETED'?'completed':code==='WARMUP_EXPIRED'?'expired':
     ['WARMUP_PREEMPTED','WARMUP_PHONE_UNAVAILABLE'].includes(code)?'paused':
     code==='WARMUP_STOPPED'?'stopped':'failed';
    update.run(state,state==='failed'&&/^[A-Z_0-9]+$/.test(code||'')?code:state==='failed'?'WARMUP_FAILED':null,id,row.day);
    if(accountFaults.has(code)){
     try{
      this.store.assertLease(lease,{owner:OWNER,externalOnly:true});
      const faults=this.store.devices().find(d=>d.id===id).faults;
      this.store.db.prepare('UPDATE devices SET faults=? WHERE id=?').run(JSON.stringify({...faults,xiaohongshu:code}),id);
      this.store.event(null,'device.login_required',{device_id:id,platform:'xiaohongshu',code});
     }catch(error){this.onError(error);}
    }
   }finally{
    clearInterval(heartbeat);
    try{
     await this.gateway.retire(lease);
     this.store.releaseExternal(lease);
     this.gateway.forgetReleased(lease);
    }catch{this.store.quarantine(id,'WARMUP_CLEANUP_FAILED');}
    finally{this.active.delete(id);}
   }
  })().catch(error=>this.onError(error));
 }
 start(){
  if(this.timer)return this;
  const poll=()=>{try{this.tick();}catch(error){this.onError(error);}};
  this.timer=setInterval(poll,500);
  this.timer.unref();
  poll();
  return this;
 }
 async close(){
  this.closing=true;
  clearInterval(this.timer);
  await Promise.allSettled([...this.active.keys()].map(id=>this.yieldDevice(id)));
 }
}
module.exports={PhoneWarmup,OWNER,localDay};
