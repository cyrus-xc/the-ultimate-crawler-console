'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {Store}=require('../service/store'),{DeviceGateway}=require('../service/device_gateway'),{createServer}=require('../service/server');
const token='http-disconnect-test-credential-not-real-0001';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){if(check())return;await sleep(5);}throw Error('test condition timeout');}
test('HTTP disconnect drains input before release and keeps the failed phone quarantined',async t=>{
 const store=new Store();store.register({id:'phone',serial:'FAKE',kind:'android'});const children=[];
 const gateway=new DeviceGateway(store,{pollMs:5,killGraceMs:5,spawnProcess:()=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.signals=[];
  child.kill=signal=>{child.signals.push(signal);return true;};child.finish=()=>{if(!child.finished){child.finished=true;child.emit('close',1);}};children.push(child);return child;
 }});
 const server=createServer({store,gateway,token});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 t.after(async()=>{for(const child of children)child.finish();await gateway.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();});
 async function post(route,payload){const response=await fetch(base+'/v1/device-leases'+route,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload)});return {status:response.status,body:await response.json()};}
 const acquired=await post('',{serial:'FAKE',owner:'review'});assert.equal(acquired.status,201);const lease=acquired.body.lease;
 const request=http.request(base+'/v1/device-leases/command',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'}});request.on('error',()=>{});request.end(JSON.stringify({lease,args:['shell','input','tap','1','1']}));
 await until(()=>children.length===1);request.destroy();await until(()=>children[0].signals.includes('SIGTERM'));
 assert.ok(gateway.status('phone'));let released=false;const release=post('/release',{lease}).then(value=>{released=true;return value;});
 await sleep(25);assert.equal(released,false);assert.ok(store.assertLease(lease));assert.ok(gateway.status('phone'));
 assert.notEqual((await post('',{serial:'FAKE',owner:'competitor'})).status,201);
 children[0].finish();assert.equal((await release).status,200);assert.equal(gateway.status('phone'),null);
 assert.equal((await post('/command',{lease,args:['get-state']})).body.error.code,'LEASE_LOST');
 assert.notEqual((await post('',{serial:'FAKE',owner:'after-drain'})).status,201);
 assert.equal(children.length,1);
});
