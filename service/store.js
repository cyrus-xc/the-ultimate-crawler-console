'use strict';
const Database = require('better-sqlite3');
const {randomUUID} = require('node:crypto');
const {normalize,digest,canonical,problem,parallelism,identifier,OPERATIONS} = require('./contract');
const TERMINAL = new Set(['succeeded','partial','failed','cancelled']);
const parse = value => value == null ? null : JSON.parse(value);
class Store {
  constructor(filename=':memory:', {now=Date.now,leaseMs=30000}={}) {
    this.now=now; this.leaseMs=leaseMs; this.db=new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('foreign_keys = ON'); this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,
        state TEXT NOT NULL,reason TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,queued_at INTEGER NOT NULL,last_dispatch INTEGER NOT NULL DEFAULT 0, UNIQUE(scope,key));
      CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES requests(id),target TEXT NOT NULL,
        state TEXT NOT NULL,checkpoint TEXT,error TEXT,started INTEGER);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,kind TEXT NOT NULL,serial TEXT,capabilities TEXT NOT NULL,
        health TEXT NOT NULL,faults TEXT NOT NULL DEFAULT '{}',generation INTEGER NOT NULL DEFAULT 0,quarantined INTEGER NOT NULL DEFAULT 0);
      CREATE UNIQUE INDEX IF NOT EXISTS device_serial ON devices(serial) WHERE serial IS NOT NULL;
      CREATE TABLE IF NOT EXISTS leases(device_id TEXT PRIMARY KEY REFERENCES devices(id),token TEXT UNIQUE NOT NULL,owner TEXT NOT NULL,
        generation INTEGER NOT NULL,expires INTEGER NOT NULL,attempt_id TEXT);
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,unit_id TEXT NOT NULL REFERENCES units(id),device_id TEXT NOT NULL REFERENCES devices(id),
        state TEXT NOT NULL,started INTEGER NOT NULL,finished INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS results(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL REFERENCES requests(id),
        unit_id TEXT NOT NULL REFERENCES units(id),item_key TEXT NOT NULL,payload TEXT NOT NULL,attempt_id TEXT NOT NULL, UNIQUE(unit_id,item_key));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT REFERENCES requests(id),type TEXT NOT NULL,
        payload TEXT NOT NULL,created INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `);
  }
  close(){this.db.close();}
  tx(fn){return this.db.transaction(fn).immediate();}
  event(id,type,payload={}) { this.db.prepare('INSERT INTO events(request_id,type,payload,created) VALUES (?,?,?,?)').run(id,type,canonical(payload),this.now()); }
  request(id,scope) {
    const row=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);
    if(!row || (scope!==undefined && row.scope!==scope)) throw problem('REQUEST_NOT_FOUND',404);
    return {id:row.id,state:row.state,reason:row.reason,created:row.created,updated:row.updated,payload:parse(row.payload),
      units:this.db.prepare('SELECT id,state,target,checkpoint,error FROM units WHERE request_id=? ORDER BY rowid').all(id)
        .map(u=>({...u,target:parse(u.target),checkpoint:parse(u.checkpoint),error:parse(u.error)}))};
  }
  submit(input,scope='local') {
    const payload=normalize(input), hash=digest(payload);
    return this.tx(()=>{
      const prior=this.db.prepare('SELECT id,hash FROM requests WHERE scope=? AND key=?').get(scope,payload.idempotency_key);
      if(prior){if(prior.hash!==hash)throw problem('IDEMPOTENCY_CONFLICT',409);return this.request(prior.id);}
      const id=randomUUID(),at=this.now();
      this.db.prepare('INSERT INTO requests(id,scope,key,hash,payload,state,created,updated,queued_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,scope,payload.idempotency_key,hash,canonical(payload),'queued',at,at,at);
      for(const target of payload.targets) this.db.prepare('INSERT INTO units(id,request_id,target,state) VALUES (?,?,?,?)').run(randomUUID(),id,canonical(target),'queued');
      this.event(id,'request.accepted'); return this.request(id);
    });
  }
  devices(){return this.db.prepare('SELECT d.*,l.owner,l.expires,l.attempt_id FROM devices d LEFT JOIN leases l ON l.device_id=d.id ORDER BY d.id').all()
    .map(d=>({...d,capabilities:parse(d.capabilities),faults:parse(d.faults)}));}
  register({id,kind,serial=null,capabilities=[]}) {
    if(!identifier(id) || !['web','android'].includes(kind) || (kind==='android' && !identifier(serial)) ||
      (kind==='web' && !['web:xhs:default','web:douyin:default'].includes(id)) || !Array.isArray(capabilities) ||
      capabilities.some(c=>!['xiaohongshu','douyin'].includes(c.platform)||!OPERATIONS.includes(c.operation))) throw problem('INVALID_DEVICE');
    if(kind==='web' && (serial!==null || capabilities.some(c=>c.platform !== (id==='web:xhs:default'?'xiaohongshu':'douyin'))))throw problem('INVALID_DEVICE');
    return this.tx(()=>{
      const prior=this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
      if(prior && (prior.kind!==kind || prior.serial!==serial))throw problem('DEVICE_IDENTITY_CONFLICT',409);
      // Registration must not clear a fault or quarantine, nor grant capabilities while held.
      if(this.db.prepare('SELECT 1 FROM leases WHERE device_id=?').get(id))throw problem('DEVICE_BUSY',409);
      this.db.prepare(`INSERT INTO devices(id,kind,serial,capabilities,health) VALUES (?,?,?,?,'ready')
        ON CONFLICT(id) DO UPDATE SET capabilities=excluded.capabilities`).run(id,kind,serial,canonical(capabilities));
      this.event(null,'device.registered',{device_id:id}); return id;
    });
  }
  compatible(d,p) {
    return p.routing.kinds.includes(d.kind) && (!p.routing.device_ids.length||p.routing.device_ids.includes(d.id)) &&
      d.capabilities.some(c=>c.platform===p.platform&&c.operation===p.operation &&
        (!p.params.sort || (Array.isArray(c.sorts)&&c.sorts.includes(p.params.sort))) &&
        (!p.params.filters || Object.keys(p.params.filters).every(k=>(c.filters||[]).includes(k))));
  }
  healthy(d,p) {return d.health==='ready'&&!d.quarantined&&!d.faults[p.platform];}
  acquire(deviceId,owner,attemptId=null) {
    const d=this.db.prepare('SELECT * FROM devices WHERE id=?').get(deviceId);
    if(!d || d.quarantined || d.health!=='ready')throw problem('DEVICE_UNAVAILABLE',409);
    if(this.db.prepare('SELECT 1 FROM leases WHERE device_id=?').get(deviceId))throw problem('DEVICE_BUSY',409);
    const generation=d.generation+1,token=randomUUID(),expires=this.now()+this.leaseMs;
    this.db.prepare('UPDATE devices SET generation=? WHERE id=?').run(generation,deviceId);
    this.db.prepare('INSERT INTO leases VALUES (?,?,?,?,?,?)').run(deviceId,token,owner,generation,expires,attemptId);
    return {device_id:deviceId,token,generation,expires,attempt_id:attemptId};
  }
  externalLease(deviceId,owner) {
    if(!identifier(owner))throw problem('INVALID_OWNER');
    return this.tx(()=>this.acquire(deviceId,owner));
  }
  fence(lease) {
    const row=this.db.prepare('SELECT * FROM leases WHERE device_id=? AND token=? AND generation=?').get(lease.device_id,lease.token,lease.generation);
    if(!row || row.expires<=this.now())throw problem('LEASE_LOST',409);
    return row;
  }
  heartbeat(lease){return this.tx(()=>{this.fence(lease);const expires=this.now()+this.leaseMs;this.db.prepare('UPDATE leases SET expires=? WHERE token=?').run(expires,lease.token);return {...lease,expires};});}
  releaseExternal(lease){return this.tx(()=>{const l=this.fence(lease);if(l.attempt_id)throw problem('WORKER_STOP_REQUIRED',409);this.db.prepare('DELETE FROM leases WHERE token=?').run(lease.token);});}
  state(id,state,reason=null) {
    const old=this.db.prepare('SELECT state,reason FROM requests WHERE id=?').get(id);
    if(old.state===state&&old.reason===reason)return;
    const enteringQueue=['queued','waiting_resources'].includes(state) && !['queued','waiting_resources'].includes(old.state);
    if(enteringQueue)this.db.prepare('UPDATE requests SET queued_at=? WHERE id=?').run(this.now(),id);
    this.db.prepare('UPDATE requests SET state=?,reason=?,updated=? WHERE id=?').run(state,reason,this.now(),id);
    this.event(id,'request.state',{state,reason});
  }
  settle(id) {
    const r=this.request(id);if(TERMINAL.has(r.state))return;
    const active=r.units.some(u=>u.state==='running');
    if(r.state==='pausing'||r.state==='cancelling') {
      if(!active)this.state(id,r.state==='pausing'?'paused':'cancelled'); return;
    }
    if(r.state==='paused')return;
    if(active){this.state(id,'running');return;}
    if(r.units.some(u=>u.state==='queued')){this.state(id,'queued');return;}
    const failed=r.units.some(u=>u.state==='failed');
    const hasResults=!!this.db.prepare('SELECT 1 FROM results WHERE request_id=? LIMIT 1').get(id);
    this.state(id,failed?(hasResults?'partial':'failed'):'succeeded');
  }
  claim() {
    return this.tx(()=>{
      this.expireInside();
      const rows=this.db.prepare("SELECT * FROM requests WHERE state IN ('queued','running','waiting_resources') ORDER BY last_dispatch,created,rowid").all();
      for(const row of rows) {
        const r=this.request(row.id),p=r.payload;
        const units=this.db.prepare("SELECT * FROM units WHERE request_id=? AND state='queued' ORDER BY rowid").all(r.id);
        if(!units.length)continue;
        const running=r.units.filter(u=>u.state==='running').length;
        if(this.now()-row.queued_at>=p.limits.queue_timeout_seconds*1000 && !running) {
          this.db.prepare("UPDATE units SET state='failed',error=? WHERE request_id=? AND state='queued'").run(canonical({code:'QUEUE_DEADLINE'}),r.id);this.settle(r.id);continue;
        }
        const candidates=this.devices().filter(d=>this.compatible(d,p));
        const healthy=candidates.filter(d=>this.healthy(d,p));
        if(!healthy.length) {
          // No registered device yet is an initial configuration wait. Existing failed devices are terminal until explicit retry.
          if(!candidates.length){if(!running)this.state(r.id,'waiting_resources','NO_CAPABLE_DEVICE');continue;}
          if(running)continue;
          this.db.prepare("UPDATE units SET state='failed',error=? WHERE request_id=? AND state='queued'").run(canonical({code:'NO_AVAILABLE_DEVICE'}),r.id);this.settle(r.id);continue;
        }
        const free=healthy.filter(d=>!d.owner);
        const competing=rows.some(other=>other.id!==r.id && free.some(d=>this.compatible(d,parse(other.payload))) &&
          this.db.prepare("SELECT 1 FROM units WHERE request_id=? AND state='queued'").get(other.id));
        const target=parallelism(p.effort,free.length+running,competing);
        if(!free.length || running>=target){if(!running)this.state(r.id,'waiting_resources','DEVICES_BUSY');continue;}
        const unit=units[0],device=free[0],attemptId=randomUUID(),at=this.now();
        if(unit.started!==null && at-unit.started>=p.limits.execution_timeout_seconds*1000){
          this.db.prepare("UPDATE units SET state='failed',error=? WHERE id=?").run(canonical({code:'EXECUTION_DEADLINE'}),unit.id);this.settle(r.id);continue;
        }
        const lease=this.acquire(device.id,r.id,attemptId);
        this.db.prepare("INSERT INTO attempts(id,unit_id,device_id,state,started) VALUES (?,?,?,'running',?)").run(attemptId,unit.id,device.id,at);
        this.db.prepare("UPDATE units SET state='running',started=coalesce(started,?) WHERE id=?").run(at,unit.id);
        // Monotonic dispatch sequence ensures fair rotation even within one clock tick.
        const dispatch=this.db.prepare('SELECT coalesce(max(last_dispatch),0)+1 n FROM requests').get().n;
        this.db.prepare('UPDATE requests SET last_dispatch=? WHERE id=?').run(dispatch,r.id);
        this.state(r.id,'running');this.event(r.id,'unit.started',{unit_id:unit.id,device_id:device.id,attempt_id:attemptId});
        return {request_id:r.id,unit_id:unit.id,attempt_id:attemptId,device_id:device.id,target:parse(unit.target),payload:p,checkpoint:parse(unit.checkpoint),lease};
      }
      return null;
    });
  }
  active(claim) {
    const lease=this.fence(claim.lease);
    const a=this.db.prepare('SELECT * FROM attempts WHERE id=? AND unit_id=? AND device_id=?').get(claim.attempt_id,claim.unit_id,claim.device_id);
    if(!a || a.state!=='running' || lease.attempt_id!==a.id || lease.owner!==claim.request_id)throw problem('ATTEMPT_LOST',409);
    const u=this.db.prepare('SELECT * FROM units WHERE id=? AND request_id=?').get(claim.unit_id,claim.request_id);
    if(!u || u.state!=='running')throw problem('ATTEMPT_LOST',409);
    return a;
  }
  commit(claim,{items=[],checkpoint=null,done=false}={}) {
    return this.tx(()=>{
      this.active(claim);
      if(!Array.isArray(items) || items.some(i=>!identifier(i.key)||!i.value||typeof i.value!=='object'))throw problem('INVALID_RESULTS');
      // First committed evidence wins; later attempts cannot change observation clocks.
      for(const item of items)this.db.prepare('INSERT OR IGNORE INTO results(request_id,unit_id,item_key,payload,attempt_id) VALUES (?,?,?,?,?)')
        .run(claim.request_id,claim.unit_id,item.key,canonical(item.value),claim.attempt_id);
      this.db.prepare('UPDATE units SET checkpoint=? WHERE id=?').run(canonical(checkpoint),claim.unit_id);
      this.event(claim.request_id,'unit.checkpoint',{unit_id:claim.unit_id,attempt_id:claim.attempt_id,count:items.length});
      if(done){this.db.prepare("UPDATE units SET state='succeeded',error=NULL WHERE id=?").run(claim.unit_id);this.finish(claim,'succeeded');}
      this.settle(claim.request_id);
    });
  }
  finish(claim,state,error=null) {
    this.db.prepare('UPDATE attempts SET state=?,finished=?,error=? WHERE id=?').run(state,this.now(),error?canonical(error):null,claim.attempt_id);
    this.db.prepare('DELETE FROM leases WHERE token=?').run(claim.lease.token);
  }
  fail(claim,error) {
    if(!error || !identifier(error.code)||!['item','platform','device'].includes(error.scope))throw problem('INVALID_ERROR');
    return this.tx(()=>{
      this.active(claim);
      if(error.scope==='device')this.db.prepare("UPDATE devices SET health='unavailable' WHERE id=?").run(claim.device_id);
      if(error.scope==='platform'){
        const d=this.db.prepare('SELECT faults FROM devices WHERE id=?').get(claim.device_id);
        this.db.prepare('UPDATE devices SET faults=? WHERE id=?').run(canonical({...parse(d.faults),[claim.payload.platform]:error.code}),claim.device_id);
      }
      this.db.prepare('UPDATE units SET state=?,error=? WHERE id=?').run(error.scope==='item'?'failed':'queued',canonical(error),claim.unit_id);
      this.finish(claim,'failed',error);this.event(claim.request_id,'unit.failed',{unit_id:claim.unit_id,device_id:claim.device_id,code:error.code});this.settle(claim.request_id);
    });
  }
  transition(id,action) {
    return this.tx(()=>{
      const r=this.request(id);
      if(action==='cancel' && !TERMINAL.has(r.state))this.state(id,'cancelling');
      else if(action==='pause' && !TERMINAL.has(r.state) && r.state!=='cancelling')this.state(id,'pausing');
      else if(action==='resume' && r.state==='paused')this.state(id,'queued');
      else if(action==='retry' && ['partial','failed'].includes(r.state)){
        this.db.prepare("UPDATE units SET state='queued',started=NULL WHERE request_id=? AND state='failed'").run(id);
        this.state(id,'queued');
      } else if(!['pause','resume','cancel','retry'].includes(action))throw problem('INVALID_ACTION');
      this.settle(id);return this.request(id);
    });
  }
  // Worker must stop device inputs BEFORE acknowledging a pause/cancellation.
  stopped(claim) {
    return this.tx(()=>{
      this.active(claim);
      const r=this.request(claim.request_id);
      if(!['pausing','cancelling'].includes(r.state))throw problem('STOP_NOT_REQUESTED',409);
      this.db.prepare("UPDATE units SET state='queued' WHERE id=?").run(claim.unit_id);
      this.finish(claim,'stopped');this.settle(claim.request_id);
    });
  }
  expireInside() {
    for(const l of this.db.prepare('SELECT * FROM leases WHERE expires<=?').all(this.now())) {
      this.db.prepare('UPDATE devices SET quarantined=1 WHERE id=?').run(l.device_id);
      this.db.prepare('DELETE FROM leases WHERE device_id=?').run(l.device_id);
      if(l.attempt_id){
        const a=this.db.prepare('SELECT * FROM attempts WHERE id=?').get(l.attempt_id);
        this.db.prepare("UPDATE attempts SET state='expired',finished=? WHERE id=?").run(this.now(),a.id);
        this.db.prepare("UPDATE units SET state='queued',error=? WHERE id=?").run(canonical({code:'LEASE_EXPIRED'}),a.unit_id);
        this.event(l.owner,'lease.expired',{device_id:l.device_id,attempt_id:a.id});this.settle(l.owner);
      }
    }
  }
  expire(){return this.tx(()=>this.expireInside());}
  // Only the local supervisor may call after confirming old process death / device isolation.
  recoverDevice(id,{stopped=false,platform=null}={}) {
    if(!stopped)throw problem('WORKER_STOP_REQUIRED',409);
    return this.tx(()=>{
      const d=this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
      if(!d)throw problem('DEVICE_NOT_FOUND',404);
      if(this.db.prepare('SELECT 1 FROM leases WHERE device_id=?').get(id))throw problem('DEVICE_BUSY',409);
      const faults=parse(d.faults);if(platform)delete faults[platform];
      this.db.prepare("UPDATE devices SET quarantined=0,health='ready',faults=? WHERE id=?").run(canonical(faults),id);
      this.event(null,'device.recovered',{device_id:id,platform});
    });
  }
  results(id,after=0,limit=100){this.request(id);return this.db.prepare('SELECT seq,item_key,payload,attempt_id,unit_id FROM results WHERE request_id=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(r=>({...r,payload:parse(r.payload)}));}
  events(id,after=0,limit=100){return this.db.prepare('SELECT seq,type,payload,created FROM events WHERE request_id IS ? AND seq>? ORDER BY seq LIMIT ?').all(id,after,limit).map(e=>({...e,payload:parse(e.payload)}));}
}
module.exports={Store,TERMINAL};
