'use strict';
// Operator-chosen work mode per device, kept in SQLite so restarts keep it.
//   off      no queue work, no warm-up
//   crawl    queue work only
//   nurture  warm-up browsing only (phones)
//   mixed    queue work, warm-up in pacing breaks and daytime sessions (default)
// A direction narrows queue work to some projects (request context.pipeline)
// and gives warm-up topics. An optional end time returns the device to mixed.
const {problem}=require('./contract');

const MODES=new Set(['off','crawl','nurture','mixed']);
const DEFAULT={mode:'mixed',projects:[],topics:[],until:null};
const HOUR=3600000;
const words=(list,code)=>{
 if(list===undefined||list===null)return [];
 if(!Array.isArray(list)||list.length>20||!list.every(w=>typeof w==='string'&&w.trim()&&w.length<=60))throw problem(code,400);
 return [...new Set(list.map(w=>w.trim()))];
};

class DeviceModes {
 constructor(store){
  this.store=store;
  store.db.exec(`CREATE TABLE IF NOT EXISTS device_modes (
    device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    mode TEXT NOT NULL, projects TEXT NOT NULL DEFAULT '[]', topics TEXT NOT NULL DEFAULT '[]',
    until INTEGER, updated INTEGER NOT NULL)`);
 }
 get(id){
  const row=this.store.db.prepare('SELECT * FROM device_modes WHERE device_id=?').get(id);
  if(!row)return {...DEFAULT};
  if(row.until!==null&&this.store.now()>=row.until){
   this.store.db.prepare('DELETE FROM device_modes WHERE device_id=?').run(id);
   this.store.event(null,'device.mode_changed',{device_id:id,mode:'mixed',reason:'expired'});
   return {...DEFAULT};
  }
  return {mode:row.mode,projects:JSON.parse(row.projects),topics:JSON.parse(row.topics),until:row.until};
 }
 set(id,{mode,projects,topics,hours}={}){
  const device=this.store.devices().find(d=>d.id===id);
  if(!device)throw problem('DEVICE_NOT_FOUND',404);
  if(!MODES.has(mode))throw problem('MODE_INVALID',400);
  if(mode==='nurture'&&device.kind!=='android')throw problem('MODE_UNSUPPORTED',409);
  if(hours!==undefined&&hours!==null&&!(Number.isFinite(hours)&&hours>0&&hours<=24*14))throw problem('MODE_HOURS_INVALID',400);
  const value={mode,projects:words(projects,'MODE_PROJECTS_INVALID'),topics:words(topics,'MODE_TOPICS_INVALID'),
   until:hours?Math.round(this.store.now()+hours*HOUR):null};
  this.store.db.prepare(`INSERT INTO device_modes(device_id,mode,projects,topics,until,updated) VALUES (?,?,?,?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET mode=excluded.mode,projects=excluded.projects,topics=excluded.topics,until=excluded.until,updated=excluded.updated`)
   .run(id,value.mode,JSON.stringify(value.projects),JSON.stringify(value.topics),value.until,this.store.now());
  this.store.event(null,'device.mode_changed',{device_id:id,...value});
  return value;
 }
 takesQueue(id){return ['crawl','mixed'].includes(this.get(id).mode);}
 warms(id){return ['nurture','mixed'].includes(this.get(id).mode);}
 nurturing(id){return this.get(id).mode==='nurture';}
 // A device with projects takes only requests whose context names one of them.
 accepts(id,payload){
  const {projects}=this.get(id);
  if(!projects.length)return true;
  const ctx=payload.context||{};
  return projects.includes(ctx.pipeline)||projects.includes(ctx.project);
 }
 view(){return this.store.devices().map(d=>({device_id:d.id,kind:d.kind,health:d.health,faults:d.faults,...this.get(d.id)}));}
}
module.exports={DeviceModes,MODES};
