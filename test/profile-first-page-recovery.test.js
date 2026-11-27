'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Store}=require('../service/store');
const {ConnectionRecovery}=require('../service/connection_recovery');
const {createServer}=require('../service/server');
const {phoneStopped}=require('../service/phone_idle');

const phone='android:one';
const web='web:xhs:default';
const miss={code:'PHONE_FIRST_PAGE_UNOBSERVED',scope:'device'};

function setup(t,{withWeb=true,targets=['one'],operation='profile.posts',filename=':memory:'}={}){
 const store=new Store(filename);
 t.after(()=>{if(store.db.open)store.close();});
 const capabilities=[{platform:'xiaohongshu',operation}];
 store.register({id:phone,kind:'android',serial:'one',capabilities});
 if(withWeb)store.register({id:web,kind:'web',capabilities});
 const targetKey=operation==='profile.posts'?'user_id':'post_id';
 const request=store.submit({schema_version:'crawler.request.v1',idempotency_key:'profiles',platform:'xiaohongshu',
  operation,effort:'full',targets:targets.map(id=>({[targetKey]:id}))});
 const claim=store.claim();
 assert.equal(claim.device_id,phone);
 return {store,request,claim,device:()=>store.devices().find(d=>d.id===phone)};
}

test('a missed first page fails over for that profile while the phone serves other profiles',t=>{
 const {store,request,claim,device}=setup(t,{targets:['one','two']});
 const held=store.externalLease(web,'other-work');
 store.fail(claim,miss);
 assert.equal(device().health,'ready');
 const other=store.claim();
 assert.equal(other.device_id,phone);
 assert.equal(other.target.user_id,'two');
 store.commit(other,{done:true});
 assert.equal(store.claim(),null);
 store.releaseExternal(held);
 const fallback=store.claim();
 assert.equal(fallback.device_id,web);
 assert.equal(fallback.unit_id,claim.unit_id);
 store.commit(fallback,{done:true});
 assert.equal(store.request(request.id).state,'succeeded');
 assert.equal(store.events(request.id).filter(e=>e.type==='unit.failed')[0].payload.code,miss.code);
});

test('exhausting the allowed phones preserves the error and explicit retry can use them again',t=>{
 const {store,claim,request}=setup(t,{withWeb:false});
 store.register({id:'android:two',kind:'android',serial:'two',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});
 store.fail(claim,miss);
 const next=store.claim();
 assert.equal(next.device_id,'android:two');
 store.fail(next,miss);
 assert.equal(store.claim(),null);
 assert.equal(store.request(request.id).state,'failed');
 assert.equal(store.request(request.id).units[0].error.code,miss.code);
 store.transition(request.id,'retry');
 assert.equal(store.claim().device_id,phone);
});

test('other device errors and other operations retain their device health policy',t=>{
 for(const [operation,error] of [['profile.posts',{code:'ADB_COMMAND_TIMEOUT',scope:'device'}],['post.detail',miss]]){
  const {store,claim,device}=setup(t,{operation});
  store.fail(claim,error);
  assert.equal(device().health,'unavailable');
 }
 const {store,claim,device}=setup(t);
 store.quarantine(phone,'RUNTIME_CLEANUP_FAILED');
 store.fail(claim,miss);
 assert.equal(device().health,'unavailable');
 assert.equal(device().quarantined,1);
});

test('reopening the queue preserves the failed unit and device pair',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profile-recovery-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const filename=path.join(dir,'queue.db'),f=setup(t,{filename});
 f.store.fail(f.claim,miss);
 f.store.close();
 const reopened=new Store(filename);
 try{
  assert.equal(reopened.devices().find(d=>d.id===phone).health,'ready');
  assert.equal(reopened.claim().device_id,web);
 }finally{reopened.close();}
});

function savedFailure({store,claim}){
 // Persist the exact device-scoped failure recorded by the previously running service.
 store.tx(()=>{
  store.finish(claim,'failed',miss);
  store.db.prepare("UPDATE units SET state='queued',error=? WHERE id=?").run(JSON.stringify(miss),claim.unit_id);
  store.db.prepare("UPDATE devices SET health='unavailable' WHERE id=?").run(phone);
  store.event(claim.request_id,'unit.failed',{device_id:phone,unit_id:claim.unit_id,code:miss.code});
  store.settle(claim.request_id);
 });
}
function repairService(t,f,verifyStopped){
 const gateway={beforeCommand(){},drain:async()=>{},recoveryFaults:new Set()};
 const inventory={refresh:async()=>[{serial:'one',state:'device'}]};
 // verifyIdle throws on missing proof; the fixtures express proof as a boolean.
 const verifyIdle=async serial=>{if(await verifyStopped(serial)!==true)throw Object.assign(Error('PHONE_INPUT_ACTIVE'),{code:'PHONE_INPUT_ACTIVE'});};
 const service=new ConnectionRecovery(f.store,gateway,inventory,{verifyIdle});
 t.after(()=>service.close());
 return service;
}

test('manual repair restores a saved first-page failure after verifying the selected idle phone',async t=>{
 const f=setup(t);savedFailure(f);
 f.store.register({id:'android:other',kind:'android',serial:'other'});
 f.store.quarantine('android:other','ADB_COMMAND_TIMEOUT');
 let checked=0;
 const repair=repairService(t,f,async serial=>{
  checked++;assert.equal(serial,'one');assert.equal(f.device().owner,'local:connection-repair');return true;
 });
 assert.equal((await repair.repair(phone,{manual:false})).health,'unavailable');
 assert.equal(checked,0);
 const token='fixture-profile-recovery-credential';
 const server=createServer({store:f.store,connectionRecovery:repair,token});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const post=async(route,body)=>{
  const res=await fetch('http://127.0.0.1:'+server.address().port+route,{method:'POST',
   headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});
  assert.ok(res.ok,route+' '+res.status);return res.json();
 };
 assert.deepEqual(await post('/v1/devices/repair-connection',{device_id:phone}),{connection_state:'device',health:'ready',capabilities:1});
 const {lease}=await post('/v1/device-leases',{device_id:phone,owner:'console:fixture'});
 await post('/v1/device-leases/release',{lease});
 assert.equal(checked,1);assert.equal(f.device().owner,null);
 assert.equal(f.store.claim().device_id,web);
 assert.equal(f.store.events(null).filter(e=>e.type==='device.recovered').length,1);
 assert.equal(f.store.devices().find(d=>d.serial==='other').quarantined,1);
});

test('manual repair preserves missing proof, platform faults, and newer incidents',async t=>{
 for(const condition of ['active input','probe error','platform fault','new quarantine','uncertain gateway','new recovery','new failure']){
  const f=setup(t);savedFailure(f);
  if(condition==='platform fault')f.store.db.prepare('UPDATE devices SET faults=? WHERE id=?').run('{"xiaohongshu":"LOGIN_REQUIRED"}',phone);
  const repair=repairService(t,f,async()=>{
   if(condition==='probe error')throw Error('probe unavailable');
   if(condition==='active input')return false;
   if(condition==='new quarantine')f.store.quarantine(phone,'RUNTIME_CLEANUP_FAILED');
   if(condition==='uncertain gateway')repair.gateway.recoveryFaults.add(phone);
   if(condition==='new recovery')f.store.event(null,'device.recovered',{device_id:phone});
   if(condition==='new failure')f.store.event(f.request.id,'unit.failed',{device_id:phone,unit_id:f.claim.unit_id,code:'ADB_COMMAND_TIMEOUT'});
   return true;
  });
  // A quarantine raised during repair supersedes it (live recovery contract).
  if(condition==='new quarantine')await assert.rejects(repair.repair(phone),{code:'RECOVERY_SUPERSEDED'});
  else assert.equal((await repair.repair(phone)).health,'unavailable',condition);
  assert.equal(f.device().owner,null);
  if(condition==='platform fault')assert.equal(f.device().faults.xiaohongshu,'LOGIN_REQUIRED');
  if(condition==='new quarantine')assert.equal(f.device().quarantined,1);
 }
});

test('a disappearing transport invalidates the idle probe before recovery',async t=>{
 const f=setup(t);savedFailure(f);
 const repair=repairService(t,f,async()=>{
  repair.inventory.refresh=async()=>[];return true;
 });
 await assert.rejects(repair.repair(phone),{code:'PHONE_RECONNECT_FAILED'});
 assert.equal(f.device().health,'unavailable');
 assert.equal(f.device().owner,null);
});

test('idle proof requires a live process listing and no input or forwarding for this serial',async()=>{
 for(const [processes,forwards,expected] of [
  ['NAME ARGS\ninit /system/bin/init','other tcp:10001 tcp:10001',true],
  ['NAME ARGS\n','',false],
  ['NAME ARGS\napp_process com.android.commands.input','',false],
  ['NAME ARGS\ninit /system/bin/init','one tcp:10001 tcp:10001',false],
 ]){
  const result=await phoneStopped('one',{run:async(_exe,args)=>{
   assert.deepEqual(args.slice(0,2),['-s','one']);
   return {stdout:args[2]==='get-state'?'device':args[2]==='shell'?processes:forwards};
  }});
  assert.equal(result,expected);
 }
});

test('manual repair also returns a phone whose App or observer ended, never one with other codes',async t=>{
 for(const [code,expected] of [['APP_MAIN_PROCESS_MISMATCH','ready'],['APP_NOT_READY','ready'],['OBSERVER_DETACHED','ready'],['CAPTURE_TIMEOUT','unavailable'],['APP_VERSION_MISMATCH','unavailable']]){
  const f=setup(t),error={code,scope:'device'};
  f.store.tx(()=>{
   f.store.finish(f.claim,'failed',error);
   f.store.db.prepare("UPDATE units SET state='queued',error=? WHERE id=?").run(JSON.stringify(error),f.claim.unit_id);
   f.store.db.prepare("UPDATE devices SET health='unavailable' WHERE id=?").run(phone);
   f.store.event(f.claim.request_id,'unit.failed',{device_id:phone,unit_id:f.claim.unit_id,code});
   f.store.settle(f.claim.request_id);
  });
  const repair=repairService(t,f,async()=>true);
  assert.equal((await repair.repair(phone)).health,expected,code);
 }
});
