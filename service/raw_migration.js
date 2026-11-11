'use strict';
// Explicit, bounded offline queue conversion. Runtime never decodes old bodies.
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const Database=require('better-sqlite3');
const {canonical}=require('./contract');
const {describe,RawEvidenceStore}=require('./raw_evidence');
const {persistResult}=require('./result_evidence');
const SCHEMA='crawler.raw_migration.v1',MARKER='.raw-evidence-migration.json';
const fail=code=>Object.assign(Error(code),{code});
const hash=value=>createHash('sha256').update(value).digest('hex');
function owned(file){file=path.resolve(file);for(let p=file;;p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw fail('RAW_MIGRATION_SYMLINK');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===path.dirname(p))break;}return file;}
function atomic(file,value){owned(file);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temporary=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temporary,'wx',0o600);try{fs.writeFileSync(fd,canonical(value));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temporary,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
function open(file,write=false){owned(file);const db=new Database(file,{readonly:!write,fileMustExist:true});db.pragma('busy_timeout=30000');db.pragma('foreign_keys=ON');if(!write)db.pragma('query_only=ON');return db;}
function marker(file){return path.join(path.dirname(path.resolve(file)),MARKER);}
function assertReadable(file,store=new RawEvidenceStore()){
 if(file===':memory:')return;file=owned(file);const record=marker(file);owned(record);
 if(fs.existsSync(record)){
  const status=JSON.parse(fs.readFileSync(record));
  if(status.schema!==SCHEMA||status.database!==file||status.status!=='committed'||!status.cutover_ref)throw fail('RAW_MIGRATION_INCOMPLETE');
  const proof=store.readJson(status.cutover_ref),observation=store.observation(status.cutover_ref);
  const expected={schema:SCHEMA,database:status.database,status:'committed',next:status.next,plan_id:status.plan_id};
  if(canonical(proof)!==canonical(expected)||observation.kind!=='storage.queue_migration.cutover'||observation.source.provider!=='queue-offline-migrator')throw fail('RAW_MIGRATION_INCOMPLETE');
 }
 if(fs.existsSync(file)){
  const db=open(file);try{if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='results'").get()){
   const legacy=db.prepare(`SELECT 1 FROM results WHERE NOT json_valid(payload) OR
    (json_type(payload,'$.data.raw') IS NOT NULL AND json_type(payload,'$.data.response_ref') IS NULL) OR
    json_type(payload,'$.data.response') IS NOT NULL OR
    (json_type(payload,'$.data.profile_end_observation') IS NOT NULL AND json_type(payload,'$.data.profile_end_observation.raw_ref') IS NULL) OR
    EXISTS(SELECT 1 FROM json_each(payload,'$.data.records') r WHERE json_type(r.value,'$.body') IS NOT NULL) LIMIT 1`).get();
   if(legacy)throw fail('RAW_MIGRATION_REQUIRED');
  }}finally{db.close();}
 }
}
function idle(db){if(db.prepare('SELECT COUNT(*) n FROM leases').get().n||db.prepare("SELECT COUNT(*) n FROM requests WHERE state NOT IN ('queued','paused','succeeded','partial','failed','cancelled')").get().n)throw fail('RAW_MIGRATION_NOT_IDLE');const commands=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='device_commands'").get();if(commands&&db.prepare('SELECT COUNT(*) n FROM device_commands').get().n)throw fail('RAW_MIGRATION_NOT_IDLE');}
function refs(value,out=[]){if(value&&typeof value==='object'){if(value.schema==='raw_ref.v1'){out.push(value);return out;}for(const child of Object.values(value))refs(child,out);}return out;}
class PlanStore{
 constructor(){this.entries=new Map();}
 capture(bytes,observation,type){const entry=describe(bytes,observation,type);this.entries.set(entry.ref.observation_id,{...entry,bytes});return entry.ref;}
}
function prepareHistorical(value,claim){
 const data=value?.data,profile=data?.raw?.native_profile;
 if(!data?.response||!profile)return value;
 const uid=claim.target.user_id,actual=profile.userid??profile.user_id??profile.id;
 if(typeof uid!=='string'||data.raw.profile_user_id!==uid||String(actual)!==uid)throw fail('RAW_MIGRATION_IDENTITY_UNKNOWN');
 const expected=canonical(profile),matches=[];
 function visit(node){if(node&&typeof node==='object'){if(canonical(node)===expected)matches.push(node);for(const child of Object.values(node))visit(child);}}
 visit(data.response);if(matches.length!==1)throw fail('RAW_MIGRATION_ORIGIN_AMBIGUOUS');
 data.raw.native_profile=matches[0];return value;
}
function metadataOnly(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['phase','data','observed_at','transport','note_id','provider','seconds'].includes(key)))return false;
 const data=value.data,scalar=item=>item===null||['string','number','boolean'].includes(typeof item);
 if(value.phase==='result'&&data===null)return true;
 if(!data||typeof data!=='object'||Array.isArray(data)||!Object.values(data).every(scalar))return false;
 const keys=Object.keys(data).sort().join();
 if(value.phase==='result'&&keys===['nickname','note_id','observed_at','poi_id','poi_name','user_id','version'].sort().join())return true;
 if(value.phase==='result'&&data.evidence_kind==='ui_identity'&&keys===['author_identity_confirmed','author_uid','evidence_kind','identity_confirmed','identity_scope','note_id','observed_at','original','poi_id','poi_name','reason','source','status'].sort().join())return true;
 return value.phase==='detail_start'&&Object.keys(data).every(key=>['note_id','user_id','profile_user_id','title','rank','index','observed_at'].includes(key));
}
function project(archive,claim,value){
 if(metadataOnly(value))return value;
 const data=value?.data;if(!data||typeof data!=='object'||Array.isArray(data))throw fail('RAW_MIGRATION_LAYOUT_UNKNOWN');
 if(data.raw_ref&&Object.hasOwn(data,'raw')||data.response_ref&&Object.hasOwn(data,'response')||data.records?.some(r=>r.raw_ref&&Object.hasOwn(r,'body')))throw fail('RAW_MIGRATION_MIXED_LAYOUT');
 const full=Object.hasOwn(data,'response')||Object.hasOwn(data,'raw')&&!data.response_ref||Array.isArray(data.records)&&data.records.some(r=>Object.hasOwn(r,'body'))||data.profile_end_observation&&!data.profile_end_observation.raw_ref;
 if(full)return persistResult(archive,claim,prepareHistorical(value,claim));
 if(refs(data).length)return value;
 throw fail('RAW_MIGRATION_LAYOUT_UNKNOWN');
}
function claimFor(db,row){const request=db.prepare('SELECT * FROM requests WHERE id=?').get(row.request_id),unit=db.prepare('SELECT * FROM units WHERE id=?').get(row.unit_id);if(!request||!unit||unit.request_id!==request.id)throw fail('RAW_MIGRATION_IDENTITY_UNKNOWN');return {claim:{request_id:request.id,target:JSON.parse(unit.target),payload:JSON.parse(request.payload)},request_hash:hash(canonical(request)),unit_hash:hash(canonical(unit))};}
function manifest(plan){return {schema:SCHEMA,database:plan.database,after:plan.after,last:plan.last,done:plan.done,max_seq:plan.max_seq,scanned:plan.scanned,rows:plan.rows.map(({before_payload,after_payload,...row})=>row),observations:[...plan.archive.entries.keys()].sort(),conflicts:plan.conflicts};}
function planQueue(file,{after=0,limit=250,maxBytes=32*1024*1024}={}){
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(maxBytes)||maxBytes<1)throw fail('RAW_MIGRATION_ARGUMENTS_INVALID');
 const database=owned(file),db=open(database),archive=new PlanStore(),plan={database,after,last:after,done:true,max_seq:0,rows:[],scanned:0,archive,conflicts:[]};
 try{db.exec('BEGIN');plan.max_seq=db.prepare('SELECT COALESCE(MAX(seq),0) n FROM results').get().n;let size=0;
  for(const row of db.prepare('SELECT seq,request_id,unit_id,attempt_id,payload FROM results WHERE seq>? ORDER BY seq').iterate(after)){
   const bytes=Buffer.byteLength(row.payload);if(plan.scanned&&(plan.scanned>=limit||size+bytes>maxBytes)){plan.done=false;break;}
   size+=bytes;plan.last=row.seq;plan.scanned++;
   try{const source=claimFor(db,row),value=JSON.parse(row.payload),thin=project(archive,source.claim,value),after_payload=canonical(thin),changed=canonical(value)!==after_payload;
    plan.rows.push({seq:row.seq,request_id:row.request_id,unit_id:row.unit_id,attempt_id:row.attempt_id,before:hash(row.payload),after:changed?hash(after_payload):hash(row.payload),before_payload:row.payload,after_payload:changed?after_payload:row.payload,request_hash:source.request_hash,unit_hash:source.unit_hash,changed});
   }catch(error){plan.conflicts.push({seq:row.seq,code:error.code||'RAW_MIGRATION_FORMAT_UNKNOWN'});}
  }
  if(plan.last>=plan.max_seq)plan.done=true;plan.id=hash(canonical(manifest(plan)));return plan;
 }finally{db.close();}
}
function verifyRow(db,row,expected){const current=db.prepare('SELECT * FROM results WHERE seq=?').get(row.seq);if(!current||hash(current.payload)!==expected||current.request_id!==row.request_id||current.unit_id!==row.unit_id||current.attempt_id!==row.attempt_id)throw fail('RAW_MIGRATION_SOURCE_CHANGED');const source=claimFor(db,current);if(source.request_hash!==row.request_hash||source.unit_hash!==row.unit_hash)throw fail('RAW_MIGRATION_CLAIM_CHANGED');return {current,source};}
function applyQueue(file,plan,{store,backupRoot,afterCommit=()=>{}}={}){
 const database=owned(file);if(!store||typeof backupRoot!=='string')throw fail('RAW_MIGRATION_ARGUMENTS_INVALID');if(plan.database!==database||plan.conflicts.length||hash(canonical(manifest(plan)))!==plan.id)throw fail('RAW_MIGRATION_PLAN_BLOCKED');
 const guardFile=marker(database),prior=fs.existsSync(guardFile)?JSON.parse(fs.readFileSync(owned(guardFile))):null;
 if(prior&&(prior.status!=='in_progress'||prior.next!==plan.after)||!prior&&plan.after!==0)throw fail('RAW_MIGRATION_SEQUENCE_INVALID');
 const backup=owned(path.join(backupRoot,plan.id));if(fs.existsSync(backup))throw fail('RAW_MIGRATION_BACKUP_EXISTS');fs.mkdirSync(backup,{recursive:true,mode:0o700});
 const db=open(database,true),journal={...manifest(plan),plan_id:plan.id,status:'prepared',backup};
 try{idle(db);const covered=db.prepare('SELECT seq FROM results WHERE seq>? AND seq<=? ORDER BY seq').all(plan.after,plan.last).map(row=>row.seq);
  if(canonical(covered)!==canonical(plan.rows.map(row=>row.seq))||db.prepare('SELECT COALESCE(MAX(seq),0) n FROM results').get().n!==plan.max_seq||plan.done!==(plan.last>=plan.max_seq))throw fail('RAW_MIGRATION_SOURCE_CHANGED');
  for(const row of plan.rows){const {source}=verifyRow(db,row,row.before),probe=new PlanStore();if(canonical(project(probe,source.claim,JSON.parse(row.before_payload)))!==canonical(JSON.parse(row.after_payload)))throw fail('RAW_MIGRATION_PLAN_CHANGED');}
  const backupFile=path.join(backup,'rows.sqlite');fs.closeSync(fs.openSync(backupFile,'wx',0o600));const saved=new Database(backupFile);try{saved.exec('CREATE TABLE rows(seq INTEGER PRIMARY KEY,payload TEXT NOT NULL)');saved.transaction(()=>{for(const row of plan.rows)saved.prepare('INSERT INTO rows VALUES(?,?)').run(row.seq,row.before_payload);})();}finally{saved.close();}
  journal.plan_ref=store.capture(Buffer.from(canonical(manifest(plan))),{platform:'storage',kind:'storage.queue_migration.plan',subject:{},observed_at:null,source:{provider:'queue-offline-migrator',artifact:'queue-migration-plan'},outcome:'planned'});
  atomic(path.join(backup,'journal.json'),journal);atomic(guardFile,{schema:SCHEMA,database,status:'in_progress',next:plan.after,plan_id:plan.id,backup});
  for(const entry of plan.archive.entries.values()){
   const {record}=entry,observation=Object.fromEntries(['platform','kind','subject','observed_at','source','outcome'].map(k=>[k,record[k]]));
   const ref=store.capture(entry.bytes,observation,record.media_type);if(ref.sha256!==entry.ref.sha256||ref.observation_id!==entry.ref.observation_id)throw fail('RAW_MIGRATION_ARCHIVE_CHANGED');
  }
  for(const row of plan.rows)for(const ref of refs(JSON.parse(row.after_payload))){store.readBytes(ref);if(ref.pointer)store.readJson(ref);}
  journal.status='applying';atomic(path.join(backup,'journal.json'),journal);
  db.transaction(()=>{idle(db);for(const row of plan.rows){verifyRow(db,row,row.before);if(row.changed)db.prepare('UPDATE results SET payload=? WHERE seq=? AND payload=?').run(row.after_payload,row.seq,row.before_payload);}}).immediate();
  afterCommit();journal.status='committed';atomic(path.join(backup,'journal.json'),journal);
  const status={schema:SCHEMA,database,status:plan.done?'committed':'in_progress',next:plan.last,plan_id:plan.id};
  if(plan.done)status.cutover_ref=store.capture(Buffer.from(canonical(status)),{platform:'storage',kind:'storage.queue_migration.cutover',subject:{},observed_at:null,source:{provider:'queue-offline-migrator',artifact:'queue-migration-cutover'},outcome:'committed'});
  atomic(guardFile,{...status,backup});return journal;
 }finally{db.close();}
}
function recoverQueue(file,{backupRoot,planId,store=new RawEvidenceStore(),rollbackCommitted=false}={}){
 if(!/^[a-f0-9]{64}$/.test(planId||''))throw fail('RAW_MIGRATION_JOURNAL_INVALID');
 const database=owned(file),backup=owned(path.join(backupRoot,planId)),journal=JSON.parse(fs.readFileSync(owned(path.join(backup,'journal.json'))));
 if(journal.schema!==SCHEMA||journal.database!==database||journal.plan_id!==planId)throw fail('RAW_MIGRATION_JOURNAL_INVALID');
 const proof=store.readJson(journal.plan_ref),observation=store.observation(journal.plan_ref);
 const recorded=Object.fromEntries(['schema','database','after','last','done','max_seq','scanned','rows','observations','conflicts'].map(key=>[key,journal[key]]));
 if(canonical(recorded)!==canonical(proof)||hash(canonical(proof))!==planId||observation.kind!=='storage.queue_migration.plan')throw fail('RAW_MIGRATION_JOURNAL_INVALID');
 if(journal.status==='rolled_back'){
  const current=JSON.parse(fs.readFileSync(owned(marker(database))));
  if(current.database!==database||current.status!=='in_progress'||!Number.isSafeInteger(current.next)||current.next<0||current.next>journal.after)throw fail('RAW_MIGRATION_SEQUENCE_INVALID');
  const db=open(database);try{for(const row of journal.rows)verifyRow(db,row,row.before);}finally{db.close();}
  return journal;
 }
 if(journal.status==='committed'&&!rollbackCommitted){
  const db=open(database);try{for(const row of journal.rows){const {current}=verifyRow(db,row,row.after);for(const ref of refs(JSON.parse(current.payload))){store.readBytes(ref);if(ref.pointer)store.readJson(ref);}}}finally{db.close();}
  const guardFile=marker(database),current=JSON.parse(fs.readFileSync(owned(guardFile)));if(current.next>=journal.last)return journal;
  if(current.next!==journal.after||current.plan_id!==planId)throw fail('RAW_MIGRATION_SEQUENCE_INVALID');
  const status={schema:SCHEMA,database,status:journal.done?'committed':'in_progress',next:journal.last,plan_id:planId};
  if(journal.done)status.cutover_ref=store.capture(Buffer.from(canonical(status)),{platform:'storage',kind:'storage.queue_migration.cutover',subject:{},observed_at:null,source:{provider:'queue-offline-migrator',artifact:'queue-migration-cutover'},outcome:'committed'});
  atomic(guardFile,{...status,backup});return journal;
 }
 if(rollbackCommitted){const current=JSON.parse(fs.readFileSync(owned(marker(database))));if(current.database!==database||current.next!==journal.last||!['committed','in_progress'].includes(current.status))throw fail('RAW_MIGRATION_SEQUENCE_INVALID');}
 const db=open(database,true),saved=new Database(owned(path.join(backup,'rows.sqlite')),{readonly:true,fileMustExist:true});
 try{idle(db);const restore=[];for(const row of journal.rows){const current=db.prepare('SELECT * FROM results WHERE seq=?').get(row.seq),original=saved.prepare('SELECT payload FROM rows WHERE seq=?').get(row.seq);if(!current||!original||hash(original.payload)!==row.before)throw fail('RAW_MIGRATION_BACKUP_CHANGED');const digest=hash(current.payload);if(digest!==row.before&&digest!==row.after)throw fail('RAW_MIGRATION_RECOVERY_CONFLICT');verifyRow(db,row,digest);if(digest===row.after&&row.changed)restore.push({seq:row.seq,payload:original.payload});}
  db.transaction(()=>{idle(db);for(const row of journal.rows){const current=db.prepare('SELECT payload FROM results WHERE seq=?').get(row.seq);if(!current||![row.before,row.after].includes(hash(current.payload)))throw fail('RAW_MIGRATION_RECOVERY_CONFLICT');verifyRow(db,row,hash(current.payload));}
   for(const row of restore)db.prepare('UPDATE results SET payload=? WHERE seq=?').run(row.payload,row.seq);}).immediate();
  journal.status='rolled_back';atomic(path.join(backup,'journal.json'),journal);atomic(marker(database),{schema:SCHEMA,database,status:'in_progress',next:journal.after,plan_id:planId,backup});return journal;
 }finally{saved.close();db.close();}
}
module.exports={planQueue,applyQueue,recoverQueue,assertReadable,manifest,prepareHistorical,SCHEMA};
