'use strict';
// Human activity for web XHS accounts, run only inside pacing breaks so it
// never takes time from collection:
//   browse   explore-feed browsing, up to a daily budget
//   follow   one proposed creator; approved by a person, or automatically
//            after its notice window unless rejected; at most followsPerDay
//   publish  an approved post; never without an explicit approval
// Proposals and decisions live in SQLite (table activities).
const {problem}=require('./contract');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR,OFFSET=8*HOUR;
const localDay=now=>Math.floor((now+OFFSET)/DAY)*DAY-OFFSET;
const OWNER='local:web-activity';
const KINDS=new Set(['follow','publish']);
const accountFault=/LOGIN|VERIFICATION|ACCOUNT|RELOGIN|RESTRICTED/;

class WebActivity {
 constructor(store,adapters,{pacer=null,random=Math.random,onError=()=>{},browseMinutesPerDay=90,followsPerDay=5,
  followGapMs=30*MIN,postsPerWeek=2,followNoticeMs=2*HOUR}={}){
  Object.assign(this,{store,adapters,pacer,random,onError,browseMinutesPerDay,followsPerDay,followGapMs,postsPerWeek,followNoticeMs});
  this.running=new Map();this.closing=false;
  store.db.exec(`CREATE TABLE IF NOT EXISTS activities (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, device_id TEXT NOT NULL, payload TEXT NOT NULL,
    state TEXT NOT NULL, note TEXT, created INTEGER NOT NULL, auto_at INTEGER, decided INTEGER, decided_by TEXT,
    done_at INTEGER, result TEXT);
   CREATE TABLE IF NOT EXISTS web_browse (device_id TEXT NOT NULL, day INTEGER NOT NULL, ms INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(device_id,day));`);
 }
 now(){return this.store.now();}
 device(id){
  const d=this.store.devices().find(x=>x.id===id);
  if(!d||d.kind!=='web'||!this.adapters.get(id)?.activity)throw problem('ACTIVITY_DEVICE_REQUIRED',404);
  return d;
 }
 // ---- proposals and decisions ----
 propose(kind,deviceId,payload,{note=null}={}){
  if(!KINDS.has(kind))throw problem('ACTIVITY_KIND_INVALID',400);
  this.device(deviceId);
  if(kind==='follow'){
   if(!/^[a-f0-9]{24}$/i.test(payload?.user_id||''))throw problem('ACTIVITY_PAYLOAD_INVALID',400);
   const seen=this.store.db.prepare(`SELECT id FROM activities WHERE kind='follow' AND json_extract(payload,'$.user_id')=? AND state!='failed'`).get(payload.user_id);
   if(seen)return this.get(seen.id);
  }
  if(kind==='publish'&&!(typeof payload?.title==='string'&&typeof payload?.content==='string'&&Array.isArray(payload?.images)&&payload.images.length))
   throw problem('ACTIVITY_PAYLOAD_INVALID',400);
  const now=this.now();
  const id=this.store.db.prepare(`INSERT INTO activities(kind,device_id,payload,state,note,created,auto_at) VALUES (?,?,?,'proposed',?,?,?)`)
   .run(kind,deviceId,JSON.stringify(payload),note,now,kind==='follow'?now+this.followNoticeMs:null).lastInsertRowid;
  this.store.event(null,'activity.proposed',{activity_id:Number(id),kind,device_id:deviceId});
  return this.get(id);
 }
 get(id){
  const r=this.store.db.prepare('SELECT * FROM activities WHERE id=?').get(id);
  if(!r)throw problem('ACTIVITY_NOT_FOUND',404);
  return {...r,payload:JSON.parse(r.payload),result:r.result?JSON.parse(r.result):null};
 }
 list({states=null,limit=50}={}){
  const rows=this.store.db.prepare('SELECT id FROM activities ORDER BY id DESC LIMIT ?').all(Math.min(200,limit));
  return rows.map(r=>this.get(r.id)).filter(a=>!states||states.includes(a.state));
 }
 decide(id,approve,by='operator'){
  const a=this.get(id);
  if(a.state!=='proposed')throw problem('ACTIVITY_ALREADY_DECIDED',409);
  this.store.db.prepare(`UPDATE activities SET state=?,decided=?,decided_by=? WHERE id=? AND state='proposed'`).run(approve?'approved':'rejected',this.now(),by,id);
  this.store.event(null,'activity.decided',{activity_id:id,approved:!!approve,by});
  return this.get(id);
 }
 // ---- execution inside pacing breaks ----
 due(deviceId,now){
  const day=localDay(now);
  // Follows past their notice window count as approved by silence.
  this.store.db.prepare(`UPDATE activities SET state='approved',decided=?,decided_by='notice' WHERE kind='follow' AND state='proposed' AND auto_at<=?`).run(now,now);
  const done=(kind,since)=>this.store.db.prepare(`SELECT count(*) n,max(done_at) last FROM activities WHERE kind=? AND device_id=? AND state='done' AND done_at>=?`).get(kind,deviceId,since);
  const posts=done('publish',now-7*DAY),postsToday=done('publish',day);
  if(posts.n<this.postsPerWeek&&!postsToday.n){
   const p=this.store.db.prepare(`SELECT id FROM activities WHERE kind='publish' AND device_id=? AND state='approved' ORDER BY id LIMIT 1`).get(deviceId);
   if(p)return {kind:'publish',activity:this.get(p.id)};
  }
  const follows=done('follow',day);
  if(follows.n<this.followsPerDay&&(!follows.last||now-follows.last>=this.followGapMs)){
   const f=this.store.db.prepare(`SELECT id FROM activities WHERE kind='follow' AND device_id=? AND state='approved' ORDER BY id LIMIT 1`).get(deviceId);
   if(f)return {kind:'follow',activity:this.get(f.id)};
  }
  const used=this.store.db.prepare('SELECT ms FROM web_browse WHERE device_id=? AND day=?').get(deviceId,day)?.ms||0;
  const left=this.browseMinutesPerDay*MIN-used;
  return left>=MIN?{kind:'browse',leftMs:left}:null;
 }
 eligible(d){
  return d.kind==='web'&&d.capabilities.some(c=>c.platform==='xiaohongshu')&&this.adapters.get(d.id)?.activity&&
   d.health==='ready'&&!d.quarantined&&!d.owner&&!d.faults.xiaohongshu&&(!this.store.modes||this.store.modes.warms(d.id));
 }
 tick(){
  if(this.closing||!this.pacer)return;
  const now=this.now();
  for(const d of this.store.devices()){
   if(this.running.has(d.id)||!this.eligible(d))continue;
   const st=this.pacer.state(d.id,now);
   if(st.state!=='break'||st.until-now<90000)continue;
   const job=this.due(d.id,now);
   if(job)this.run(d,job,st.until-now);
  }
 }
 run(device,job,windowMs){
  let lease;
  try{lease=this.store.externalLease(device.id,OWNER);}catch{return;}
  const controller=new AbortController(),started=this.now(),adapter=this.adapters.get(device.id);
  // Keep the lease alive through a multi-minute browse; a lost lease stops it.
  const heartbeat=setInterval(()=>{try{this.store.heartbeat(lease);}catch{controller.abort();}},Math.max(10,Math.floor(this.store.leaseMs/3)));
  heartbeat.unref();
  const task=(async()=>{
   try{
    if(job.kind==='browse'){
     const seconds=Math.max(30,Math.min(240,Math.floor((Math.min(windowMs,job.leftMs)-20000)/1000)));
     const data=await adapter.activity('/browse',{seconds,opens:1+Math.floor(this.random()*3)},{signal:controller.signal});
     this.store.db.prepare(`INSERT INTO web_browse(device_id,day,ms) VALUES (?,?,?) ON CONFLICT(device_id,day) DO UPDATE SET ms=ms+excluded.ms`)
      .run(device.id,localDay(started),this.now()-started);
     this.store.event(null,'activity.browsed',{device_id:device.id,...data,ms:this.now()-started});
    }else{
     const a=job.activity;
     const body=a.kind==='follow'?{user_id:a.payload.user_id,...(a.payload.xsec_token?{xsec_token:a.payload.xsec_token}:{})}:
      {title:a.payload.title,content:a.payload.content,tags:a.payload.tags||[],images:a.payload.images,visibility:a.payload.visibility||''};
     const data=await adapter.activity('/'+a.kind,body,{signal:controller.signal});
     this.store.db.prepare(`UPDATE activities SET state='done',done_at=?,result=? WHERE id=?`).run(this.now(),JSON.stringify(data),a.id);
     this.store.event(null,'activity.done',{activity_id:a.id,kind:a.kind,device_id:device.id});
    }
   }catch(error){
    const code=error.code||'ACTIVITY_FAILED';
    if(job.activity)this.store.db.prepare(`UPDATE activities SET state='failed',done_at=?,result=? WHERE id=?`).run(this.now(),JSON.stringify({code}),job.activity.id);
    this.store.event(null,'activity.failed',{device_id:device.id,kind:job.kind,code});
    if(error.scope==='platform'){
     // The same signals that brake collection brake this device.
     if(this.pacer.brakeCodes.has(code)||accountFault.test(code))
      try{this.pacer.brake(device.id,code,this.pacer.row(device.id),this.now());}catch(e){this.onError(e);}
     if(accountFault.test(code)){
      const faults=this.store.devices().find(x=>x.id===device.id).faults;
      this.store.db.prepare('UPDATE devices SET faults=? WHERE id=?').run(JSON.stringify({...faults,xiaohongshu:code}),device.id);
      this.store.event(null,'device.login_required',{device_id:device.id,platform:'xiaohongshu',code});
     }
    }
   }finally{
    clearInterval(heartbeat);
    try{this.store.releaseExternal(lease);}catch(e){this.onError(e);}
    this.running.delete(device.id);
   }
  })();
  this.running.set(device.id,{controller,task});
 }
 start(){
  if(this.timer)return this;
  this.timer=setInterval(()=>{try{this.tick();}catch(e){this.onError(e);}},2000);this.timer.unref();
  return this;
 }
 async close(){
  this.closing=true;clearInterval(this.timer);
  for(const r of this.running.values())r.controller.abort();
  await Promise.allSettled([...this.running.values()].map(r=>r.task));
 }
}
module.exports={WebActivity,OWNER};
