'use strict';
// Per-device pacing between collection items: variable gaps, short breaks
// after a run of items, a daily cap, a daily sleep window per device and an
// automatic brake after platform detection signals. State lives in SQLite so a
// restart cannot reset caps or brakes. The queue still owns ordering/leases;
// the pacer only decides which devices may receive their next item now.
const fs=require('node:fs'),path=require('node:path');

const MIN=60000,HOUR=60*MIN,DAY=24*HOUR,OFFSET=8*HOUR;
const localDay=now=>Math.floor((now+OFFSET)/DAY)*DAY-OFFSET;
const clock=text=>{const [h,m]=String(text).split(':').map(Number);return (h*60+m)*MIN;};
// Stable pseudo-random value per (device, day, salt): sleep windows must not
// move between calls on the same day.
function seeded(key){
 let h=2166136261;for(const c of key){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}
 h+=0x6D2B79F5;h=Math.imul(h^h>>>15,h|1);h^=h+Math.imul(h^h>>>7,h|61);return ((h^h>>>14)>>>0)/4294967296;
}

function loadProfile(name,file=path.join(__dirname,'..','config','pacing.json')){
 const all=JSON.parse(fs.readFileSync(file,'utf8'));
 if(!all[name])throw Object.assign(Error('PACING_PROFILE_UNKNOWN'),{code:'PACING_PROFILE_UNKNOWN'});
 return all[name];
}

class Pacer {
 constructor(store,profile,{random=Math.random,now=()=>store.now()}={}){
  Object.assign(this,{store,profile,random,now});
  this.brakeCodes=new Set(profile.brake.codes);
  store.db.exec(`CREATE TABLE IF NOT EXISTS device_pacing (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    day INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, burst_left INTEGER NOT NULL,
    next_at INTEGER NOT NULL DEFAULT 0, break_until INTEGER NOT NULL DEFAULT 0,
    brake_until INTEGER NOT NULL DEFAULT 0, slow_until INTEGER NOT NULL DEFAULT 0,
    last_brake_at INTEGER, stopped_day INTEGER, reason TEXT)`);
 }
 between([min,max]){return min+this.random()*(max-min);}
 gap(settings){
  // Log-normal around the median, bounded; Box-Muller from the random source.
  const u=Math.max(1e-9,this.random()),v=this.random();
  const z=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
  const s=settings.median*Math.exp(settings.sigma*z);
  return Math.min(settings.max,Math.max(settings.min,s))*1000;
 }
 settings(id){
  const kind=this.store.db.prepare('SELECT kind FROM devices WHERE id=?').get(id)?.kind;
  return kind==='android'?this.profile.android:this.profile.web;
 }
 row(id,now=this.now()){
  const settings=this.settings(id),day=localDay(now);
  let row=this.store.db.prepare('SELECT * FROM device_pacing WHERE device_id=?').get(id);
  if(!row){
   row={device_id:id,day,count:0,burst_left:Math.round(this.between(settings.burst)),next_at:now+this.between(settings.start_stagger_s)*1000,
    break_until:0,brake_until:0,slow_until:0,last_brake_at:null,stopped_day:null,reason:null};
   this.store.db.prepare(`INSERT INTO device_pacing(device_id,day,count,burst_left,next_at) VALUES (?,?,?,?,?)`).run(id,day,0,row.burst_left,row.next_at);
  }else if(row.day!==day){
   row.day=day;row.count=0;
   this.store.db.prepare('UPDATE device_pacing SET day=?,count=0 WHERE device_id=?').run(day,id);
  }
  return row;
 }
 // [from,to) sleep windows that may contain `now` (yesterday's can run past midnight).
 sleepWindow(id,now=this.now()){
  const settings=this.settings(id),spec=settings.sleep?.[id];
  if(!spec)return null;
  const jitter=(settings.sleep_jitter_min||0)*MIN;
  for(const day of [localDay(now),localDay(now)-DAY]){
   const j=salt=>Math.round((seeded(id+':'+day+':'+salt)*2-1)*jitter);
   const from=day+clock(spec[0])+j('from');let to=day+clock(spec[1])+j('to');
   if(to<=from)to+=DAY;
   if(now>=from&&now<to)return [from,to];
  }
  return null;
 }
 state(id,now=this.now()){
  const settings=this.settings(id),row=this.row(id,now);
  if(row.stopped_day===localDay(now)||now<row.brake_until)return {state:'brake',until:row.brake_until,reason:row.reason};
  const sleep=this.sleepWindow(id,now);
  if(sleep)return {state:'sleep',until:sleep[1]};
  if(row.count>=settings.daily_cap)return {state:'daily_cap',until:localDay(now)+DAY};
  if(now<row.break_until)return {state:'break',until:row.break_until};
  if(now<row.next_at)return {state:'gap',until:row.next_at};
  return {state:'ready',until:null};
 }
 ready(id,now=this.now()){return this.state(id,now).state==='ready';}
 inBreak(id,now=this.now()){return this.state(id,now).state==='break';}
 started(id,now=this.now()){
  this.row(id,now);
  this.store.db.prepare('UPDATE device_pacing SET count=count+1,burst_left=burst_left-1 WHERE device_id=?').run(id);
 }
 finished(id,code=null,now=this.now()){
  const settings=this.settings(id),row=this.row(id,now),brake=this.profile.brake;
  let gap=this.gap(settings.gap_s);
  if(now<row.slow_until)gap*=brake.slow_factor;
  const update={next_at:Math.round(now+gap),burst_left:row.burst_left,break_until:row.break_until};
  if(row.burst_left<=0){
   update.break_until=Math.round(now+this.between(settings.break_s)*1000);
   update.burst_left=Math.round(this.between(settings.burst));
  }
  this.store.db.prepare('UPDATE device_pacing SET next_at=?,burst_left=?,break_until=? WHERE device_id=?').run(update.next_at,update.burst_left,update.break_until,id);
  if(code&&this.brakeCodes.has(code))this.brake(id,code,row,now);
 }
 brake(id,code,row,now){
  const brake=this.profile.brake;
  const repeat=row.last_brake_at!==null&&now-row.last_brake_at<brake.repeat_window_h*HOUR;
  let until,stopped=null;
  if(repeat){
   // Second signal within the window: rest this device until tomorrow.
   stopped=localDay(now);until=Math.round(localDay(now)+DAY+this.between([0,60])*MIN);
  }else until=Math.round(now+this.between(brake.pause_min)*MIN);
  this.store.db.prepare('UPDATE device_pacing SET brake_until=?,slow_until=?,last_brake_at=?,stopped_day=?,reason=? WHERE device_id=?')
   .run(until,until+brake.slow_hours*HOUR,now,stopped,code,id);
  this.store.event(null,'device.pacing_brake',{device_id:id,code,until,repeat});
 }
 view(id,now=this.now()){
  const settings=this.settings(id),row=this.row(id,now),state=this.state(id,now);
  return {...state,count:row.count,cap:settings.daily_cap};
 }
}
module.exports={Pacer,loadProfile,localDay,seeded};
