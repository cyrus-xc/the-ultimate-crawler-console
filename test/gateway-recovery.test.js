'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Store}=require('../service/store'),{DeviceGateway}=require('../service/device_gateway');
const {start}=require('../service/main');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function devices(store){
 for(const [id,serial] of [['android:RECOVERY_ONE','RECOVERY_ONE'],['android:RECOVERY_TWO','RECOVERY_TWO']])store.register({id,kind:'android',serial});
}
function storeFixture(t){const store=new Store();devices(store);t.after(()=>store.close());return store;}

test('known persisted quarantine clears only after each explicit trusted device recovery',t=>{
 const store=storeFixture(t);
 store.quarantine('android:RECOVERY_ONE');store.quarantine('android:RECOVERY_TWO');
 const gateway=new DeviceGateway(store);
 assert.equal(gateway.requiresRecovery(),true);
 assert.throws(()=>store.recoverDevice('android:RECOVERY_ONE'),{code:'WORKER_STOP_REQUIRED'});
 store.recoverDevice('android:RECOVERY_ONE',{stopped:true});
 assert.equal(gateway.requiresRecovery(),true,'one of two quarantines is still unresolved');
 store.recoverDevice('android:RECOVERY_TWO',{stopped:true});
 assert.equal(gateway.requiresRecovery(),false,'confirmed DB recovery is not permanently blocked by an old memory snapshot');
});

test('active in-memory work and unknown persisted commands cannot appear recovered',t=>{
 const store=storeFixture(t),gateway=new DeviceGateway(store);
 gateway.active.set('test-active',{abort:()=>{}});
 assert.equal(gateway.requiresRecovery(),true,'active work is unsafe even if no command row is visible');
 assert.throws(()=>gateway.recoverDevice('android:RECOVERY_TWO',{stopped:true}),{code:'WORKER_STOP_REQUIRED'});
 gateway.active.delete('test-active');
 store.db.prepare('INSERT INTO device_commands VALUES (?,?,?,?,?,?,?,?,?)').run('android:RECOVERY_ONE','orphan','token',1,'former',123,null,'unknown',0);
 assert.equal(gateway.requiresRecovery(),true);
 assert.throws(()=>store.recoverDevice('android:RECOVERY_ONE',{stopped:true}),{code:'DEVICE_COMMAND_ACTIVE'});
 assert.throws(()=>gateway.confirmStopped('android:RECOVERY_ONE',{commandId:'orphan'}),{code:'WORKER_STOP_REQUIRED'});
 assert.equal(gateway.requiresRecovery(),true);
 gateway.confirmStopped('android:RECOVERY_ONE',{commandId:'orphan',stopped:true});
 assert.equal(gateway.requiresRecovery(),true,'command cleanup alone is not the device recovery receipt');
 gateway.recoverDevice('android:RECOVERY_ONE',{stopped:true});
 assert.equal(gateway.requiresRecovery(),false);
});

for(const writeFailure of ['quarantine','command'])test('uncertain cancellation stays fail-closed after '+writeFailure+' persistence fails and local child closes',async t=>{
 const store=storeFixture(t),children=[];
 const gateway=new DeviceGateway(store,{pollMs:1000,timeoutMs:10000,spawnProcess:()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
  child.finish=()=>child.emit('close',1);children.push(child);return child;
 }});
 const lease=store.externalLease('android:RECOVERY_ONE','recovery-test');
 const operation=gateway.execute(lease,{args:['shell','input','tap','1','1']});
 const stopped=operation.catch(error=>error);
 await tick();assert.equal(children.length,1);
 const prepare=store.db.prepare;
 store.db.prepare=function(sql){
  if((writeFailure==='quarantine'&&sql.startsWith('UPDATE devices SET quarantined=1'))||
     (writeFailure==='command'&&sql.startsWith("UPDATE device_commands SET state='stopping'")))throw Object.assign(Error('synthetic write failure'),{code:'SYNTHETIC_DB_WRITE_FAILED'});
  return prepare.call(this,sql);
 };
 await assert.rejects(gateway.cancel(lease),{code:'SYNTHETIC_DB_WRITE_FAILED'});
 store.db.prepare=prepare;
 children[0].finish();
 assert.equal((await stopped).code,'DEVICE_COMMAND_CANCELLED');
 await tick();
 assert.equal(gateway.active.size,0);
 assert.equal(gateway.status('android:RECOVERY_ONE'),null);
 assert.equal(gateway.requiresRecovery(),true,'local close plus absent DB command is not proof that remote input stopped');
 store.releaseExternal(lease);
 store.recoverDevice('android:RECOVERY_ONE',{stopped:true});
 assert.equal(gateway.requiresRecovery(),true,'DB-only restoration cannot clear unpersisted uncertainty');
 gateway.recoverDevice('android:RECOVERY_TWO',{stopped:true});
 assert.equal(gateway.requiresRecovery(),true,'another device recovery cannot clear this device uncertainty');
 assert.throws(()=>gateway.recoverDevice('android:RECOVERY_ONE'),{code:'WORKER_STOP_REQUIRED'});
 assert.equal(gateway.requiresRecovery(),true,'missing proof never clears uncertainty');
 gateway.recoverDevice('android:RECOVERY_ONE',{stopped:true});
 assert.equal(gateway.requiresRecovery(),false);
});

test('two trusted recovered devices permit real normal main.close to release only its own guardian',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-recovered-close-'));
 const token=path.join(root,'token'),adb=path.join(root,'fake-adb'),locks=path.join(root,'legacy-lock');
 fs.writeFileSync(token,'synthetic-recovery-credential-not-real-123456789');
 fs.writeFileSync(adb,`#!${process.execPath}\nif(process.argv[2]!=='devices')process.exit(2);process.stdout.write('List of devices attached\\nRECOVERY_ONE device model:test\\nRECOVERY_TWO device model:test\\n');\n`,{mode:0o700});
 const saved=new Store(path.join(root,'queue.db'));devices(saved);
 saved.quarantine('android:RECOVERY_ONE');saved.quarantine('android:RECOVERY_TWO');saved.close();
 const service=await start({listen:false,env:{CRAWLER_RUNTIME_DIR:root,CRAWLER_SERVICE_TOKEN_FILE:token,CRAWLER_DEVICE_GATEWAY_ENABLED:'true',CRAWLER_LEGACY_ANDROID_LOCK_DIR:locks,ADB_PATH:adb}});
 const file=path.join(locks,'.worker.lock'),guardianPid=Number(fs.readFileSync(file,'utf8'));
 t.after(async()=>{
  await service.close().catch(()=>{});
  // Only this test's freshly spawned guardian; never enumerate runtime PIDs.
  if(fs.existsSync(file)){try{process.kill(guardianPid,'SIGKILL');}catch{}}
  fs.rmSync(root,{recursive:true,force:true});
 });
 service.store.recoverDevice('android:RECOVERY_ONE',{stopped:true});
 assert.equal(service.gateway.requiresRecovery(),true);
 service.store.recoverDevice('android:RECOVERY_TWO',{stopped:true});
 assert.equal(service.gateway.active.size,0);
 assert.equal(service.gateway.requiresRecovery(),false);
 await service.close();
 assert.equal(fs.existsSync(file),false,'normal owning IPC release must retire the guardian lock');
});

test('unknown database read failure cannot authorize a release',t=>{
 const store=storeFixture(t),gateway=new DeviceGateway(store),prepare=store.db.prepare;
 store.db.prepare=function(sql){
  if(sql.startsWith('SELECT 1 FROM device_commands'))throw Object.assign(Error('synthetic read failure'),{code:'SYNTHETIC_DB_READ_FAILED'});
  return prepare.call(this,sql);
 };
 assert.throws(()=>gateway.requiresRecovery(),{code:'SYNTHETIC_DB_READ_FAILED'});
 store.db.prepare=prepare;
});
