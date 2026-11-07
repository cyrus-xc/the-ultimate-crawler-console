'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');const {Store}=require('../service/store'),{createServer}=require('../service/server'),{DeviceGateway}=require('../service/device_gateway');
const token='device-api-test-token-not-real-credential-1234';
async function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'device-api-'));fs.writeFileSync(path.join(root,'fake-adb.cjs'),"setTimeout(()=>process.stdout.write('ok'),80);");
 const store=new Store();for(const serial of ['s1','s2'])store.register({id:'android:'+serial,serial,kind:'android',capabilities:[]});
 let active=0,maxActive=0;const bySerial=new Map(),maxBySerial=new Map();
 const gateway=new DeviceGateway(store,{spawnProcess:(binary,args,options)=>{
  assert.equal(args[0],'-s');const serial=args[1];active++;maxActive=Math.max(maxActive,active);bySerial.set(serial,(bySerial.get(serial)||0)+1);maxBySerial.set(serial,Math.max(maxBySerial.get(serial)||0,bySerial.get(serial)));
  const child=spawn(process.execPath,[path.join(root,'fake-adb.cjs'),...args],options);child.once('close',()=>{active--;bySerial.set(serial,bySerial.get(serial)-1);});return child;
 }});
 const server=createServer({store,token,gateway});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{await gateway.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();fs.rmSync(root,{recursive:true,force:true});});
 const post=async(route,payload,headers={})=>{const response=await fetch(url+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json',...headers},body:JSON.stringify(payload)});return {status:response.status,body:await response.json()};};
 return {store,gateway,url,post,maxBySerial,getMax:()=>maxActive};
}
test('HTTP leases run two phones concurrently while serializing one physical phone',async t=>{
 const {post,getMax,maxBySerial}=await setup(t);
 const a=await post('/v1/device-leases',{serial:'s1',owner:'parse-links:one'}),b=await post('/v1/device-leases',{serial:'s2',owner:'poi:two'});assert.equal(a.status,201);assert.equal(b.status,201);assert.notEqual(a.body.device.clipboard_port,b.body.device.clipboard_port);
 const command=lease=>post('/v1/device-leases/command',{lease,args:['shell',"'input'","'tap'","'10'","'10'"]});
 const results=await Promise.all([command(a.body.lease),command(a.body.lease),command(b.body.lease)]);
 assert.ok(results.every(r=>r.status===200));assert.equal(getMax(),2);assert.equal(maxBySerial.get('s1'),1);assert.equal(maxBySerial.get('s2'),1);
 assert.equal((await post('/v1/device-leases/release',{lease:a.body.lease})).status,200);
 assert.equal((await command(a.body.lease)).body.error.code,'LEASE_LOST');
 const fresh=await post('/v1/device-leases',{serial:'s1',owner:'parse-links:new'});assert.equal(fresh.status,201);assert.ok(fresh.body.lease.generation>a.body.lease.generation);
});
test('lease API rejects wrong physical device, invalid authority and unauthenticated calls',async t=>{
 const {post,url}=await setup(t),acquired=await post('/v1/device-leases',{serial:'s1',owner:'tool'}),lease=acquired.body.lease;
 const bad=await post('/v1/device-leases/command',{lease,serial:'s2',args:['shell',"'input'","'tap'","'1'","'2'"]});assert.equal(bad.body.error.code,'DEVICE_IDENTITY_MISMATCH');
 assert.equal((await post('/v1/device-leases/heartbeat',{lease:{...lease,token:'not-the-token'}})).body.error.code,'LEASE_LOST');
 assert.equal((await fetch(url+'/v1/device-leases',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({serial:'s1',owner:'tool'})})).status,401);
 const listed=await (await fetch(url+'/v1/devices',{headers:{authorization:'Bearer '+token}})).json();assert.ok(!JSON.stringify(listed).includes(lease.token));
 assert.equal((await post('/v1/device-leases/command',{lease,args:['shell',"'su'","'-c'","'arbitrary'"]})).body.error.code,'ADB_COMMAND_UNSUPPORTED');
});
test('heartbeat renews a lease and lease release closes future command admission',async t=>{
 const {store,post}=await setup(t);let clock=100;store.now=()=>clock;
 const acquired=await post('/v1/device-leases',{serial:'s1',owner:'tool'});clock=1100;
 const renewed=await post('/v1/device-leases/heartbeat',{lease:acquired.body.lease});assert.equal(renewed.status,200);assert.ok(renewed.body.lease.expires>acquired.body.lease.expires);
 assert.equal((await post('/v1/device-leases/assert',{lease:renewed.body.lease})).body.valid,true);
 assert.equal((await post('/v1/device-leases/release',{lease:renewed.body.lease})).body.released,true);
});
