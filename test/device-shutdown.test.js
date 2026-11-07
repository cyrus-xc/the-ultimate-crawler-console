'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {start}=require('../service/main'),{Store}=require('../service/store'),{DeviceGateway}=require('../service/device_gateway');
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gateway-shutdown-'));const tokenFile=path.join(root,'token'),adbPath=path.join(root,'fake-adb'),lockDir=path.join(root,'lock');
 fs.writeFileSync(tokenFile,'test-only-shutdown-credential-not-real-123456');
 fs.writeFileSync(adbPath,`#!${process.execPath}\nif(process.argv[2]!=='devices')process.exit(2);process.stdout.write('List of devices attached\\nFAKE device model:test\\n');\n`,{mode:0o700});
 const service=await start({listen:false,env:{CRAWLER_RUNTIME_DIR:root,CRAWLER_SERVICE_TOKEN_FILE:tokenFile,CRAWLER_DEVICE_GATEWAY_ENABLED:'true',CRAWLER_LEGACY_ANDROID_LOCK_DIR:lockDir,ADB_PATH:adbPath}});
 const lock=path.join(lockDir,'.worker.lock'),guardianPid=Number(fs.readFileSync(lock,'utf8'));
 t.after(async()=>{await service.close().catch(()=>{});if(fs.existsSync(lock)){try{process.kill(guardianPid,'SIGKILL');}catch{}}fs.rmSync(root,{recursive:true,force:true});});
 return {service,lock,guardianPid};
}
test('clean service shutdown releases the legacy guardian lock',async t=>{
 const {service,lock}=await fixture(t);assert.equal(service.gateway.requiresRecovery(),false);await service.close();assert.equal(fs.existsSync(lock),false);
});
test('shutdown abort waits for local child close but keeps guardian until remote recovery',async t=>{
 const {service,lock,guardianPid}=await fixture(t);const children=[];
 service.gateway.spawnProcess=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.signals=[];child.kill=signal=>{child.signals.push(signal);setImmediate(()=>child.emit('close',1));return true;};children.push(child);return child;};
 const lease=service.store.externalLease('android:FAKE','shutdown-test');
 const operation=service.gateway.execute(lease,{args:['shell','input','swipe','1','1','2','2','1000']});const result=operation.catch(error=>error);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(children.length,1);
 await assert.rejects(service.close(),{code:'DEVICE_RECOVERY_REQUIRED'});
 assert.equal((await result).code,'GATEWAY_CLOSED');assert.deepEqual(children[0].signals,['SIGTERM']);
 assert.equal(service.gateway.requiresRecovery(),true);assert.equal(fs.readFileSync(lock,'utf8'),String(guardianPid));assert.doesNotThrow(()=>process.kill(guardianPid,0));
});
test('persisted orphan command requires recovery even after command row cleanup',t=>{
 const store=new Store();store.register({id:'p',kind:'android',serial:'FAKE'});const first=new DeviceGateway(store);
 store.db.prepare("INSERT INTO device_commands VALUES (?,?,?,?,?,?,?,?,?)").run('p','orphan','token',1,'old-gateway',123,null,'running',0);
 const restarted=new DeviceGateway(store);assert.equal(restarted.requiresRecovery(),true);
 restarted.confirmStopped('p',{commandId:'orphan',stopped:true});assert.equal(restarted.status('p'),null);assert.equal(restarted.requiresRecovery(),true);store.close();
});
