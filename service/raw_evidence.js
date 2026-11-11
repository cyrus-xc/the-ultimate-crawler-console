'use strict';
// Body hashes describe producer-owned bytes. Metadata has integer byte counts
// and string leaves, matching Python's sorted compact UTF-8 record encoding.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const Database=require('better-sqlite3');
const {canonical}=require('./contract');
const SCHEMA='raw_ref.v1',HEX=/^[a-f0-9]{64}$/;
const fail=code=>Object.assign(Error(code),{code,status:409,scope:'item'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function pointer(value){if(typeof value!=='string'||value&&!value.startsWith('/')||/~(?![01])/.test(value))throw fail('RAW_REF_POINTER_INVALID');return value?value.slice(1).split('/').map(p=>p.replace(/~1/g,'/').replace(/~0/g,'~')):[];}
function metadata(value){
 const keys=['platform','kind','subject','observed_at','source','outcome'];
 if(!value||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join())throw fail('RAW_OBSERVATION_INVALID');
 if(['platform','kind','outcome'].some(k=>typeof value[k]!=='string'||!value[k])||value.observed_at!==null&&typeof value.observed_at!=='string')throw fail('RAW_OBSERVATION_INVALID');
 for(const [field,allowed] of [['subject',['uid','note_id','media_id']],['source',['provider','request_id','session_id','run_id','stage_id','endpoint','artifact']]]){
  const object=value[field];if(!object||Array.isArray(object)||typeof object!=='object'||Object.keys(object).some(k=>!allowed.includes(k))||Object.values(object).some(v=>typeof v!=='string'))throw fail('RAW_OBSERVATION_INVALID');
 }
 if(Object.values(value.source).some(v=>/bearer\s|(?:token|secret|password)=/i.test(v)))throw fail('RAW_OBSERVATION_SOURCE_INVALID');
 return value;
}
function describe(bytes,observation,mediaType='application/json'){
 if(!Buffer.isBuffer(bytes))throw fail('RAW_EVIDENCE_BYTES_REQUIRED');metadata(observation);
 if(typeof mediaType!=='string'||!mediaType)throw fail('RAW_MEDIA_TYPE_INVALID');
 const sha256=hash(bytes),record={schema:SCHEMA,sha256,bytes:bytes.length,media_type:mediaType,...observation},encoded=Buffer.from(canonical(record),'utf8');
 return {ref:{schema:SCHEMA,sha256,observation_id:hash(encoded),pointer:''},record,encoded};
}
class RawEvidenceStore{
 constructor(root=process.env.XHS_RAW_EVIDENCE_ROOT||'/run/media/pcd/optane2/database/backup/raw-evidence'){this.root=path.resolve(root);this.filename=path.join(this.root,'evidence.sqlite');}
 guard(){
  const fixed=path.resolve('/run/media/pcd/optane2'),configured=process.env.XHS_RAW_EVIDENCE_MOUNT,mounts=new Set([fixed]);
  if(configured){const declared=path.resolve(configured);if(this.root!==declared&&!this.root.startsWith(declared+path.sep))throw fail('RAW_EVIDENCE_MOUNT_SCOPE_INVALID');mounts.add(declared);}
  for(const mount of mounts)if(this.root===mount||this.root.startsWith(mount+path.sep)){
   const present=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').map(line=>line.split(' ')[4]?.replace(/\\040/g,' '));
   if(!present.includes(mount))throw fail('PRIMARY_STORAGE_UNAVAILABLE');
  }
  for(const sidecar of [this.filename+'-wal',this.filename+'-shm']){try{if(fs.lstatSync(sidecar).isSymbolicLink())throw fail('RAW_REF_SYMLINK_REJECTED');}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(let p=this.filename;;p=path.dirname(p)){try{if(fs.lstatSync(p).isSymbolicLink())throw fail('RAW_REF_SYMLINK_REJECTED');}catch(e){if(e.code!=='ENOENT')throw e;}if(p===path.dirname(p))break;}
 }
 open(write=false){
  this.guard();
  if(write){fs.mkdirSync(this.root,{recursive:true,mode:0o700});this.guard();try{fs.closeSync(fs.openSync(this.filename,'wx',0o600));}catch(error){if(error.code!=='EEXIST')throw error;}}
  else if(!fs.existsSync(this.filename))throw fail('RAW_EVIDENCE_UNAVAILABLE');
  const db=new Database(this.filename,{readonly:!write,fileMustExist:true});
  try{db.pragma('busy_timeout=30000');db.pragma('foreign_keys=ON');
  if(write){db.pragma('journal_mode=WAL');db.pragma('synchronous=FULL');db.exec(`CREATE TABLE IF NOT EXISTS objects(hash TEXT PRIMARY KEY, bytes INTEGER NOT NULL, content BLOB NOT NULL, CHECK(bytes>=0 AND length(content)=bytes)); CREATE TABLE IF NOT EXISTS observations(hash TEXT PRIMARY KEY, object_hash TEXT NOT NULL REFERENCES objects(hash), metadata BLOB NOT NULL); CREATE TRIGGER IF NOT EXISTS objects_no_update BEFORE UPDATE ON objects BEGIN SELECT RAISE(ABORT,'immutable object'); END; CREATE TRIGGER IF NOT EXISTS objects_no_delete BEFORE DELETE ON objects BEGIN SELECT RAISE(ABORT,'immutable object'); END; CREATE TRIGGER IF NOT EXISTS observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT,'immutable observation'); END; CREATE TRIGGER IF NOT EXISTS observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT,'immutable observation'); END;`);}
  else db.pragma('query_only=ON');
  return db;}catch(error){db.close();throw error;}
 }
 capture(bytes,observation,mediaType='application/json'){
  const described=describe(bytes,observation,mediaType);
  let db;
  try{
   db=this.open(true);const {ref:{sha256,observation_id},encoded}=described;
   db.transaction(()=>{
    const old=db.prepare('SELECT bytes,content FROM objects WHERE hash=?').get(sha256);
    if(old){if(old.bytes!==bytes.length||hash(old.content)!==sha256)throw fail('RAW_EVIDENCE_HASH_MISMATCH');}
    else db.prepare('INSERT INTO objects(hash,bytes,content) VALUES(?,?,?)').run(sha256,bytes.length,bytes);
    const previous=db.prepare('SELECT object_hash,metadata FROM observations WHERE hash=?').get(observation_id);
    if(previous){if(previous.object_hash!==sha256||hash(previous.metadata)!==observation_id)throw fail('RAW_OBSERVATION_HASH_MISMATCH');}
    else db.prepare('INSERT INTO observations(hash,object_hash,metadata) VALUES(?,?,?)').run(observation_id,sha256,encoded);
   }).immediate();
   return {schema:SCHEMA,sha256,observation_id,pointer:''};
  }catch(error){if(error.scope==='item')throw error;throw fail('RAW_EVIDENCE_UNAVAILABLE');}finally{db?.close();}
 }
 observation(ref){
  if(!ref||typeof ref!=='object'||Array.isArray(ref)||Object.keys(ref).sort().join()!==['schema','sha256','observation_id','pointer'].sort().join()||ref.schema!==SCHEMA)throw fail('RAW_REF_INVALID');
  pointer(ref.pointer);if(!HEX.test(ref.sha256||'')||!HEX.test(ref.observation_id||''))throw fail('RAW_REF_DIGEST_INVALID');
  let db;try{db=this.open();const row=db.prepare('SELECT object_hash,metadata FROM observations WHERE hash=?').get(ref.observation_id);if(!row)throw fail('RAW_EVIDENCE_UNAVAILABLE');if(hash(row.metadata)!==ref.observation_id)throw fail('RAW_OBSERVATION_HASH_MISMATCH');
   let record;try{record=JSON.parse(row.metadata);}catch{throw fail('RAW_OBSERVATION_INVALID');}
   if(record.schema!==SCHEMA||record.sha256!==ref.sha256||row.object_hash!==ref.sha256)throw fail('RAW_REF_OBSERVATION_MISMATCH');return record;
  }catch(error){if(error.scope==='item')throw error;throw fail('RAW_EVIDENCE_UNAVAILABLE');}finally{db?.close();}
 }
 readBytes(ref){const record=this.observation(ref);let db;try{db=this.open();const row=db.prepare('SELECT bytes,content FROM objects WHERE hash=?').get(ref.sha256);if(!row)throw fail('RAW_EVIDENCE_UNAVAILABLE');if(hash(row.content)!==ref.sha256||row.bytes!==record.bytes||row.content.length!==record.bytes)throw fail('RAW_EVIDENCE_HASH_MISMATCH');return row.content;}catch(error){if(error.scope==='item')throw error;throw fail('RAW_EVIDENCE_UNAVAILABLE');}finally{db?.close();}}
 readJson(ref){let value;try{value=JSON.parse(this.readBytes(ref));}catch(error){if(error.code)throw error;throw fail('RAW_EVIDENCE_JSON_INVALID');}for(const key of pointer(ref.pointer)){if(!value||typeof value!=='object'||Array.isArray(value)&&!/^(0|[1-9][0-9]*)$/.test(key)||!Object.hasOwn(value,key))throw fail('RAW_REF_POINTER_MISSING');value=value[key];}return value;}
 stats(){let db;try{this.guard();if(!fs.existsSync(this.filename))return {objects:0,observations:0,bytes:0};db=this.open();return {objects:db.prepare('SELECT COUNT(*) n FROM objects').get().n,observations:db.prepare('SELECT COUNT(*) n FROM observations').get().n,bytes:db.prepare('SELECT COALESCE(SUM(bytes),0) n FROM objects').get().n};}finally{db?.close();}}
}
module.exports={RawEvidenceStore,SCHEMA,describe};
