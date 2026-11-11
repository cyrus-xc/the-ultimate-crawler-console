'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
const Database=require('better-sqlite3');
const {Store}=require('../service/store'),{RawEvidenceStore}=require('../service/raw_evidence');
const {canonical}=require('../service/contract');
const {planQueue,applyQueue,recoverQueue}=require('../service/raw_migration');
const STAMP='2026-10-01T00:00:00Z',UID='a'.repeat(24);
function fixture(t,{count=1,native=false,unknown=false,metadata=null}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-queue-migration-')),file=path.join(root,'queue.db'),archive=path.join(root,'archive'),backupRoot=path.join(root,'backup'),raw=new RawEvidenceStore(archive);
 const queue=new Store(file,{rawEvidence:raw});
 queue.register({id:'web:xhs:default',kind:'web',capabilities:['post.detail','profile.get'].map(operation=>({platform:'xiaohongshu',operation}))});
 const before=[];
 for(let i=0;i<count;i++){
  const request=queue.submit({schema_version:'crawler.request.v1',idempotency_key:'old-'+i,platform:'xiaohongshu',operation:native?'profile.get':'post.detail',targets:[native?{user_id:UID}:{post_id:'note-'+i}]}),claim=queue.claim();
  const profile={userid:UID,nickname:'原账号'},response={data:{user:profile}},value=metadata??(unknown?{data:{unknown_body:{source:'retain'}}}:native?{phase:'result',observed_at:STAMP,data:{response,raw:{profile_user_id:UID,native_profile:JSON.parse(JSON.stringify(profile)),profile:{basicInfo:{nickname:'原账号'}},feeds:[]}}}:{phase:'result',observed_at:STAMP,data:{raw:{note:{noteId:'note-'+i,desc:'原文',user:{userId:UID}}},stop_reason:'target_loaded',end_observed:false}});
  const payload=canonical(value);queue.db.prepare('INSERT INTO results(request_id,unit_id,item_key,payload,attempt_id) VALUES(?,?,?,?,?)').run(request.id,claim.unit_id,'result',payload,claim.attempt_id);
  queue.commit(claim,{checkpoint:{cursor:'unchanged',seen_ids:['note-'+i]},done:true});before.push(payload);
 }
 const protectedTables=['requests','units','attempts','devices','leases','decisions','events'];
 const snapshot=Object.fromEntries(protectedTables.map(table=>[table,queue.db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));queue.close();
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,file,archive,backupRoot,raw,before,snapshot,protectedTables};
}
function protectedRows(f){const db=new Database(f.file,{readonly:true});try{return Object.fromEntries(f.protectedTables.map(table=>[table,db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all()]));}finally{db.close();}}
function values(f){const db=new Database(f.file,{readonly:true});try{return db.prepare('SELECT payload FROM results ORDER BY seq').all().map(row=>row.payload);}finally{db.close();}}

test('dry queue plan writes no archive; apply preserves every operational table and original observation',t=>{
 const f=fixture(t);assert.throws(()=>new Store(f.file,{rawEvidence:f.raw}),{code:'RAW_MIGRATION_REQUIRED'});
 const plan=planQueue(f.file);assert.equal(plan.rows.length,1);assert.equal(plan.conflicts.length,0);assert.deepEqual(f.raw.stats(),{objects:0,observations:0,bytes:0});assert.deepEqual(values(f),f.before);
 applyQueue(f.file,plan,{store:f.raw,backupRoot:f.backupRoot});
 const thin=JSON.parse(values(f)[0]);assert.equal(thin.data.raw,undefined);assert.equal(f.raw.readJson(thin.data.raw_ref).note.desc,'原文');assert.equal(f.raw.observation(thin.data.raw_ref).observed_at,STAMP);
 assert.deepEqual(protectedRows(f),f.snapshot);const reopened=new Store(f.file,{rawEvidence:f.raw});reopened.close();
 assert.equal(fs.statSync(path.join(f.backupRoot,plan.id,'rows.sqlite')).mode&0o777,0o600);
});

test('serialized native profiles bind only to one complete original subtree, not a UID-only guess',t=>{
 const f=fixture(t,{native:true}),plan=planQueue(f.file);assert.equal(plan.conflicts.length,0);applyQueue(f.file,plan,{store:f.raw,backupRoot:f.backupRoot});
 const value=JSON.parse(values(f)[0]),ref=value.data.raw.native_profile_ref;assert.equal(ref.sha256,value.data.response_ref.sha256);assert.deepEqual(f.raw.readJson(ref),{userid:UID,nickname:'原账号'});
 assert.deepEqual(protectedRows(f),f.snapshot);
});

test('source bytes changed after planning are never overwritten or silently re-planned',t=>{
 const f=fixture(t),plan=planQueue(f.file),db=new Database(f.file);const changed=f.before[0]+' ';db.prepare('UPDATE results SET payload=?').run(changed);db.close();
 assert.throws(()=>applyQueue(f.file,plan,{store:f.raw,backupRoot:f.backupRoot}),{code:'RAW_MIGRATION_SOURCE_CHANGED'});assert.deepEqual(values(f),[changed]);assert.deepEqual(protectedRows(f),f.snapshot);
});

test('unknown result layouts remain explicit conflicts and receive no destructive projection',t=>{
 const f=fixture(t,{unknown:true}),plan=planQueue(f.file);assert.equal(plan.conflicts[0].code,'RAW_MIGRATION_LAYOUT_UNKNOWN');assert.throws(()=>applyQueue(f.file,plan,{store:f.raw,backupRoot:f.backupRoot}),{code:'RAW_MIGRATION_PLAN_BLOCKED'});assert.deepEqual(values(f),f.before);assert.deepEqual(f.raw.stats(),{objects:0,observations:0,bytes:0});
});

test('bounded batches keep readers blocked until all original result rows have been converted',t=>{
 const f=fixture(t,{count:2}),one=planQueue(f.file,{limit:1});assert.equal(one.done,false);applyQueue(f.file,one,{store:f.raw,backupRoot:f.backupRoot});assert.throws(()=>new Store(f.file,{rawEvidence:f.raw}),{code:'RAW_MIGRATION_INCOMPLETE'});
 const two=planQueue(f.file,{after:one.last,limit:1});assert.equal(two.done,true);applyQueue(f.file,two,{store:f.raw,backupRoot:f.backupRoot});const queue=new Store(f.file,{rawEvidence:f.raw});queue.close();assert.deepEqual(protectedRows(f),f.snapshot);
});

function crash(f){
 const program=`const {planQueue,applyQueue}=require(process.argv[1]+'/service/raw_migration');const {RawEvidenceStore}=require(process.argv[1]+'/service/raw_evidence');const [file,archive,backupRoot]=process.argv.slice(2);applyQueue(file,planQueue(file),{store:new RawEvidenceStore(archive),backupRoot,afterCommit(){process.exit(71)}});`;
 const child=spawnSync(process.execPath,['-e',program,path.resolve(__dirname,'..'),f.file,f.archive,f.backupRoot],{env:{...process.env,ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'},encoding:'utf8'});assert.equal(child.status,71,child.stderr);return JSON.parse(fs.readFileSync(path.join(path.dirname(f.file),'.raw-evidence-migration.json'))).plan_id;
}

test('hard child exit after SQLite commit leaves a durable journal and explicit rollback restores exact original rows',t=>{
 const f=fixture(t),planId=crash(f);assert.notDeepEqual(values(f),f.before);assert.throws(()=>new Store(f.file,{rawEvidence:f.raw}),{code:'RAW_MIGRATION_INCOMPLETE'});
 const result=recoverQueue(f.file,{store:f.raw,backupRoot:f.backupRoot,planId});assert.equal(result.status,'rolled_back');assert.deepEqual(values(f),f.before);assert.deepEqual(protectedRows(f),f.snapshot);assert.throws(()=>new Store(f.file,{rawEvidence:f.raw}),{code:'RAW_MIGRATION_INCOMPLETE'});
});

test('recovery refuses an operator/new-writer edit instead of restoring over unknown data',t=>{
 const f=fixture(t),planId=crash(f),db=new Database(f.file),changed='{"new":"operator data"}';db.prepare('UPDATE results SET payload=?').run(changed);db.close();
 assert.throws(()=>recoverQueue(f.file,{store:f.raw,backupRoot:f.backupRoot,planId}),{code:'RAW_MIGRATION_RECOVERY_CONFLICT'});assert.deepEqual(values(f),[changed]);assert.deepEqual(protectedRows(f),f.snapshot);
});


test('global rollback restores committed batches only in reverse order and refuses changed after bytes',t=>{
 const f=fixture(t,{count:2}),one=planQueue(f.file,{limit:1});applyQueue(f.file,one,{store:f.raw,backupRoot:f.backupRoot});
 const two=planQueue(f.file,{after:one.last,limit:1});applyQueue(f.file,two,{store:f.raw,backupRoot:f.backupRoot});
 assert.throws(()=>recoverQueue(f.file,{store:f.raw,backupRoot:f.backupRoot,planId:one.id,rollbackCommitted:true}),{code:'RAW_MIGRATION_SEQUENCE_INVALID'});
 recoverQueue(f.file,{store:f.raw,backupRoot:f.backupRoot,planId:two.id,rollbackCommitted:true});
 recoverQueue(f.file,{store:f.raw,backupRoot:f.backupRoot,planId:one.id,rollbackCommitted:true});
 assert.equal(recoverQueue(f.file,{store:f.raw,backupRoot:f.backupRoot,planId:one.id,rollbackCommitted:true}).status,'rolled_back');
 assert.deepEqual(values(f),f.before);assert.deepEqual(protectedRows(f),f.snapshot);
 const g=fixture(t),plan=planQueue(g.file);applyQueue(g.file,plan,{store:g.raw,backupRoot:g.backupRoot});
 const db=new Database(g.file);db.prepare('UPDATE results SET payload=?').run('{"operator":"new"}');db.close();
 assert.throws(()=>recoverQueue(g.file,{store:g.raw,backupRoot:g.backupRoot,planId:plan.id,rollbackCommitted:true}),{code:'RAW_MIGRATION_RECOVERY_CONFLICT'});
});


test('offline CLI uses the exact persisted digest plan and supports committed global rollback',t=>{
 const f=fixture(t),planFile=path.join(f.root,'plan.json'),tool=path.resolve(__dirname,'../tools/raw-evidence-migration.cjs');
 function run(args){return spawnSync(process.execPath,[tool,...args],{env:{...process.env,XHS_RAW_EVIDENCE_ROOT:f.archive,XHS_RAW_EVIDENCE_MOUNT:'',ENABLE_TIKHUB_NETWORK:'0',ENABLE_LLM_NETWORK:'0'},encoding:'utf8'});}
 const planned=run(['plan','--database',f.file,'--output',planFile]);assert.equal(planned.status,0,planned.stderr);const id=JSON.parse(planned.stdout).plan_id;
 assert.deepEqual(values(f),f.before);assert.equal(fs.statSync(planFile).mode&0o777,0o600);
 const applied=run(['apply','--database',f.file,'--plan',planFile,'--backup-root',f.backupRoot]);assert.equal(applied.status,0,applied.stderr);assert.equal(JSON.parse(applied.stdout).status,'committed');
 const rolled=run(['recover','--database',f.file,'--backup-root',f.backupRoot,'--plan-id',id,'--rollback-committed']);assert.equal(rolled.status,0,rolled.stderr);assert.equal(JSON.parse(rolled.stdout).status,'rolled_back');assert.deepEqual(values(f),f.before);assert.deepEqual(protectedRows(f),f.snapshot);
});


test('known share-page/identity metadata, empty result and profile progress remain exact byte no-ops',t=>{
 const records=[{phase:'result',observed_at:STAMP,data:null},{phase:'detail_start',observed_at:STAMP,note_id:'n',data:{profile_user_id:UID}},
  {phase:'result',observed_at:STAMP,data:{nickname:'observed',note_id:'n',observed_at:STAMP,poi_id:null,poi_name:null,user_id:UID,version:'fixture'}},
  {phase:'result',observed_at:STAMP,transport:'android_ui',data:{author_identity_confirmed:true,author_uid:UID,evidence_kind:'ui_identity',identity_confirmed:true,identity_scope:'note_and_author',note_id:'n',observed_at:STAMP,original:null,poi_id:null,poi_name:null,reason:null,source:'android_known_post',status:'observed'}}];
 for(const metadata of records){const f=fixture(t,{metadata}),plan=planQueue(f.file);assert.deepEqual(plan.conflicts,[]);assert.equal(plan.rows[0].changed,false);assert.equal(plan.archive.entries.size,0);applyQueue(f.file,plan,{store:f.raw,backupRoot:f.backupRoot});assert.deepEqual(values(f),f.before);assert.deepEqual(protectedRows(f),f.snapshot);}
 const f=fixture(t,{metadata:{...records[2],data:{...records[2].data,body:{raw:'must remain a conflict'}}}});assert.equal(planQueue(f.file).conflicts[0].code,'RAW_MIGRATION_LAYOUT_UNKNOWN');
});
