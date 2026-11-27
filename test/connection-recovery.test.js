'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Store}=require('../service/store');
const {ConnectionRecovery}=require('../service/connection_recovery');
const {createServer}=require('../service/server');

function fixture(t,{hasDisplay=()=>false}={}){
 let now=1000;
 const store=new Store(':memory:',{now:()=>now});
 const id='android:phone', serial='phone';
 store.register({id,serial,kind:'android'});
 store.register({id:'android:other',serial:'other',kind:'android'});
 const inventory={snapshot:new Map(),async refresh(){
  const found=[...this.snapshot.values()];
  store.setPresence(id,found.some(item=>item.serial===serial&&item.state==='device'));
  return found;
 }};
 const calls=[];
 const gate={
  beforeCommand(){},
  async executeTrusted(lease,command){
   assert.equal(store.assertLease(lease).owner,'local:connection-repair');
   assert.equal(lease.device_id,id);
   calls.push(command);
   inventory.snapshot.set(serial,{serial,state:'device'});
  },
  async drain(){},
 };
 const recovery=new ConnectionRecovery(store,gate,inventory,{sleep:async()=>{},hasDisplay});
 t.after(async()=>{await recovery.close();store.close();});
 return {store,id,serial,inventory,gate,recovery,calls,at:value=>{now=value;}};
}
test('automatic repair targets only a known offline transport under its lease',async t=>{
 const f=fixture(t);
 f.inventory.snapshot.set(f.serial,{serial:f.serial,state:'offline'});
 await f.inventory.refresh();
 assert.equal(f.store.devices().find(d=>d.id===f.id).health,'disconnected');
 f.recovery.tick();
 await f.recovery.pending.get(f.id);
 assert.deepEqual(f.calls,[{serial:f.serial,args:['reconnect']}]);
 assert.equal(f.store.devices().find(d=>d.id===f.id).health,'ready');
 assert(f.store.devices().every(d=>!d.owner));
 assert.equal(f.store.events(null).filter(e=>e.type==='device.connection_verified').length,1);
});
test('repair preserves platform and capture failures even when transport is online',async t=>{
 const f=fixture(t);
 f.inventory.snapshot.set(f.serial,{serial:f.serial,state:'device'});
 f.store.db.prepare("UPDATE devices SET health='unavailable',faults=? WHERE id=?").run('{"xiaohongshu":"LOGIN_REQUIRED"}',f.id);
 const response=await f.recovery.repair(f.id);
 assert.deepEqual(response,{connection_state:'device',health:'unavailable',capabilities:0});
 assert.deepEqual(f.calls,[]);
 assert.deepEqual(f.store.devices().find(d=>d.id===f.id).faults,{xiaohongshu:'LOGIN_REQUIRED'});
});
test('repair rejects active control, active display, and unauthorized or absent devices',async t=>{
 let display=false;
 const f=fixture(t,{hasDisplay:()=>display});
 const lease=f.store.externalLease(f.id,'test');
 await assert.rejects(f.recovery.repair(f.id),{code:'DEVICE_BUSY'});
 f.store.releaseExternal(lease);
 display=true;
 await assert.rejects(f.recovery.repair(f.id),{code:'DEVICE_BUSY'});
 display=false;
 await assert.rejects(f.recovery.repair(f.id),{code:'PHONE_NOT_DETECTED'});
 f.inventory.snapshot.set(f.serial,{serial:f.serial,state:'unauthorized'});
 await assert.rejects(f.recovery.repair(f.id),{code:'ADB_AUTHORIZATION_REQUIRED'});
 f.store.quarantine(f.id,'RUNTIME_CLEANUP_FAILED');
 await assert.rejects(f.recovery.repair(f.id),{code:'ADB_AUTHORIZATION_REQUIRED'});
 assert.deepEqual(f.calls,[]);
});
test('concurrent clicks share one repair, and offline automatic retries are bounded',async t=>{
 const f=fixture(t);
 f.inventory.snapshot.set(f.serial,{serial:f.serial,state:'offline'});
 f.gate.executeTrusted=async(_lease,command)=>f.calls.push(command);
 const a=f.recovery.repair(f.id),b=f.recovery.repair(f.id);
 assert.equal(a,b);
 await assert.rejects(a,{code:'PHONE_RECONNECT_FAILED'});
 f.recovery.tick();
 assert.equal(f.recovery.pending.size,0);
 f.at(61000);
 f.recovery.tick();
 await assert.rejects(f.recovery.pending.get(f.id),{code:'PHONE_RECONNECT_FAILED'});
 assert.equal(f.calls.length,2);
});
test('the authenticated repair route accepts only a single Android device id',async t=>{
 const f=fixture(t);
 f.inventory.snapshot.set(f.serial,{serial:f.serial,state:'offline'});
 const token='fixture-device-repair-credential-000';
 const server=createServer({store:f.store,token,connectionRecovery:f.recovery});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const call=(body,headers={})=>fetch('http://127.0.0.1:'+server.address().port+'/v1/devices/repair-connection',{
  method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),
 });
 const auth={authorization:'Bearer '+token};
 assert.equal((await call({device_id:f.id})).status,401);
 assert.equal((await call({device_id:'web:xhs:default'},auth)).status,400);
 const result=await call({device_id:f.id},auth);
 assert.equal(result.status,200);
 assert.equal((await result.json()).connection_state,'device');
 assert.equal(f.calls.length,1);
});
