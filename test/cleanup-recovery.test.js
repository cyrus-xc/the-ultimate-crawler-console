'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../service/store');
const {DeviceGateway}=require('../service/device_gateway');
const {ConnectionRecovery}=require('../service/connection_recovery');
const {verifyPhoneIdle}=require('../service/phone_idle');
const {createServer}=require('../service/server');

function fixture(t,{file=':memory:',now=1000,verifyIdle=async()=>{}}={}){
 const store=new Store(file,{now:()=>now}),id='android:test';
 store.register({kind:'android',id,serial:'TEST'});
 const inventory={snapshot:new Map(),async refresh(){return [...this.snapshot.values()];}};
 const gateway=new DeviceGateway(store);
 const recovery=new ConnectionRecovery(store,gateway,inventory,{verifyIdle,sleep:async()=>{}});
 t.after(async()=>{await recovery.close();await gateway.close();store.close();});
 const device=()=>store.devices().find(d=>d.id===id);
 const view=()=>recovery.describe(device());
 const tick=async()=>{recovery.tick();await Promise.allSettled(recovery.pending.values());};
 return {store,id,inventory,gateway,recovery,device,view,tick,at:v=>{now=v;}};
}

test('each failure doubles the durable delay to 24 hours, repeated capped attempts continue, success clears the incident',async t=>{
 const f=fixture(t);f.store.quarantine(f.id,'ADB_COMMAND_TIMEOUT');
 f.at(5999);await f.tick();assert.equal(f.view().history.length,1);
 let due=6000,delay=5000;
 for(let n=1;n<=18;n++){
  assert.equal(f.view().next_retry_at,due);
  f.at(due);await f.tick();delay=Math.min(86400000,delay*2);due+=delay;
  const log=f.view();
  assert.equal(log.reason,'ADB_COMMAND_TIMEOUT');assert.equal(log.history[0].attempt,n);
  assert.equal(log.history[0].code,'PHONE_NOT_DETECTED');assert.equal(log.next_retry_at,due);
  f.at(due-1);await f.tick();assert.equal(f.view().history[0].attempt,n);
 }
 f.inventory.snapshot.set('TEST',{serial:'TEST',state:'device'});
 f.at(due);await f.tick();assert.equal(f.device().quarantined,0);assert.equal(f.view(),null);
 assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type IN ('device.repair_started','device.repair_failed')").get().n,0);
 f.store.quarantine(f.id,'DEVICE_COMMAND_CANCELLED');assert.equal(f.view().next_retry_at,due+5000);
 assert.deepEqual(f.view().history.map(r=>r.type),['device.quarantined']);
});
test('restart preserves the pending retry, and a new isolation resets it to five seconds',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phone-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'queue.db'),f=fixture(t,{file});f.store.quarantine(f.id,'ADB_COMMAND_TIMEOUT');f.at(6000);await f.tick();
 const next=fixture(t,{file,now:7500});assert.equal(next.view().next_retry_at,16000);
 await next.tick();assert.equal(next.view().history[0].attempt,1);
 next.store.quarantine(next.id,'WORKER_STOP_TIMEOUT');assert.equal(next.view().next_retry_at,12500);
});
test('lease expiry starts its own retry schedule and manual repair shares automatic work',async t=>{
 let done,entered;const started=new Promise(r=>{entered=r;});
 const f=fixture(t,{verifyIdle:()=>{entered();return new Promise(r=>{done=r;});}});
 f.store.externalLease(f.id,'expired');f.at(40000);f.store.expire();
 f.inventory.snapshot.set('TEST',{serial:'TEST',state:'device'});assert.equal(f.view().next_retry_at,45000);
 f.at(45000);f.recovery.tick();await started;
 const work=f.recovery.pending.get(f.id);assert.equal(f.recovery.repair(f.id),work);
 assert.equal(f.view().running,true);assert.equal(f.view().next_retry_at,null);
 f.store.quarantine(f.id,'DEVICE_COMMAND_CANCELLED');done();await assert.rejects(work,{code:'RECOVERY_SUPERSEDED'});
 assert.equal(f.device().owner,null);assert.equal(f.device().quarantined,1);assert.equal(f.view().next_retry_at,50000);
});
test('quarantine reconnect goes through the real device gateway and retains platform faults',async t=>{
 const marker=fs.mkdtempSync(path.join(os.tmpdir(),'quarantine-adb-'));t.after(()=>fs.rmSync(marker,{recursive:true,force:true}));
 const adb=path.join(marker,'adb');
 fs.writeFileSync(adb,'#!/bin/sh\ntest "$#" = 3 && test "$1" = "-s" && test "$2" = "TEST" && test "$3" = "reconnect" && touch "'+marker+'/connected"\n',{mode:0o700});
 const f=fixture(t);f.gateway.adbPath=adb;
 f.inventory.refresh=async()=>[{serial:'TEST',state:fs.existsSync(path.join(marker,'connected'))?'device':'offline'}];
 f.store.db.prepare('UPDATE devices SET faults=?').run(JSON.stringify({xiaohongshu:'LOGIN_REQUIRED'}));
 f.store.quarantine(f.id,'RUNTIME_CLEANUP_FAILED');
 assert.throws(()=>f.store.externalLease(f.id,'manual'),{code:'DEVICE_UNAVAILABLE'});
 f.at(6000);await f.tick();assert.ok(fs.existsSync(path.join(marker,'connected')));assert.equal(f.device().quarantined,0);
 assert.deepEqual(f.device().faults,{xiaohongshu:'LOGIN_REQUIRED'});assert.equal(f.device().owner,null);
});
test('a failed idle check preserves isolation and reports the reason and next retry over HTTP',async t=>{
 const f=fixture(t,{verifyIdle:async()=>{throw Object.assign(Error(),{code:'PHONE_FORWARD_ACTIVE'});}});
 f.inventory.snapshot.set('TEST',{serial:'TEST',state:'device'});f.store.quarantine(f.id,'ADB_COMMAND_TIMEOUT');
 const token='fixture-recovery-status-token-testing-only',server=createServer({store:f.store,token,connectionRecovery:f.recovery});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
 f.at(6000);await f.tick();
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/devices',{headers:{authorization:'Bearer '+token}});
 const [phone]=(await response.json()).devices;
 assert.equal(phone.quarantined,1);assert.equal(phone.recovery.history[0].code,'PHONE_FORWARD_ACTIVE');assert.equal(phone.recovery.next_retry_at,16000);
 assert.equal(phone.owner,null);
});
test('a leased phone backs off independently while a second phone recovers',async t=>{
 const f=fixture(t),other='android:second';f.store.register({id:other,kind:'android',serial:'SECOND'});
 const lease=f.store.externalLease(f.id,'test-owner');
 f.store.quarantine(f.id,'WORKER_STOP_TIMEOUT');f.store.quarantine(other,'DEVICE_COMMAND_CANCELLED');
 f.inventory.snapshot.set('SECOND',{serial:'SECOND',state:'device'});f.at(6000);await f.tick();
 assert.equal(f.view().history[0].code,'DEVICE_BUSY');assert.equal(f.view().next_retry_at,16000);
 assert.equal(f.store.assertLease(lease).owner,'test-owner');assert.equal(f.store.devices().find(d=>d.id===other).quarantined,0);
});
test('shutdown during verification releases the repair lease and retains quarantine',async t=>{
 let entered,finish;const probing=new Promise(r=>{entered=r;});
 const f=fixture(t,{verifyIdle:()=>{entered();return new Promise(r=>{finish=r;});}});f.store.quarantine(f.id,'ADB_COMMAND_TIMEOUT');
 f.inventory.snapshot.set('TEST',{serial:'TEST',state:'device'});
 f.at(6000);const pending=f.tick();await probing;const closed=f.recovery.close();finish();await Promise.all([pending,closed]);
 assert.equal(f.device().quarantined,1);assert.equal(f.device().owner,null);
});
test('remote proof uses explicit serial, rejects residual processes, forwards, offline and malformed reads',async()=>{
 for(const mode of ['clear','offline','runtime','input','forward','invalid','error']){
  const calls=[];const ok=await verifyPhoneIdle('PHONE',{run:async(_exe,args)=>{
   calls.push(args);assert.deepEqual(args.slice(0,2),['-s','PHONE']);
   if(mode==='error')throw Error('ADB failed');
   if(args[2]==='get-state')return {stdout:mode==='offline'?'offline':'device'};
   if(args[2]==='forward')return {stdout:mode==='forward'?'PHONE tcp:12345 tcp:27043':'OTHER tcp:12345 tcp:27043'};
   return {stdout:mode==='invalid'?'':'NAME ARGS\n'+(mode==='runtime'?'xhs-lab-frida-16.7.19 daemon':mode==='input'?'app_process com.android.commands.input tap 1 1':'init /system/bin/init')};
  }}).then(()=>true,()=>false);assert.equal(ok,mode==='clear',mode);assert.ok(calls.length);
 }
});
test('service startup schedules persisted cleanup recovery and shutdown releases its lock',async t=>{
 const {start}=require('../service/main');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cleanup-recovery-service-'));
 const token=path.join(root,'token'),adb=path.join(root,'adb'),locks=path.join(root,'locks');
 fs.writeFileSync(token,'synthetic-cleanup-service-credential-123456789');
 fs.writeFileSync(adb,`#!${process.execPath}\nconst a=process.argv.slice(2);if(a[0]==='devices')console.log('List of devices attached\\nPHONE device model:fixture');else if(a[0]==='-s'&&a[1]==='PHONE'){if(a[2]==='get-state')console.log('device');else if(a[2]==='shell')console.log('NAME ARGS\\ninit /system/bin/init');else if(a[2]!=='forward')process.exit(1);}else process.exit(1);\n`,{mode:0o700});
 const saved=new Store(path.join(root,'queue.db'),{now:()=>Date.now()-5001});saved.register({id:'phone',kind:'android',serial:'PHONE'});saved.quarantine('phone','RUNTIME_CLEANUP_FAILED');saved.close();
 const service=await start({listen:false,env:{CRAWLER_RUNTIME_DIR:root,CRAWLER_SERVICE_TOKEN_FILE:token,CRAWLER_DEVICE_GATEWAY_ENABLED:'true',CRAWLER_LEGACY_ANDROID_LOCK_DIR:locks,ADB_PATH:adb}});
 t.after(async()=>{await service.close().catch(()=>{});fs.rmSync(root,{recursive:true,force:true});});
 const deadline=Date.now()+3000;
 while(service.store.devices()[0].quarantined&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
 assert.equal(service.store.devices()[0].quarantined,0);
 assert.equal(service.store.events(null).filter(e=>e.type==='device.connection_verified').length,1);
 await service.close();assert.equal(fs.existsSync(path.join(locks,'.worker.lock')),false);
});
