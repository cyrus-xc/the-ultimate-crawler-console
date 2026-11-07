const test=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),http=require('node:http');
const {WebSocket}=require('ws'),{Store}=require('../service/store'),{DesktopControl}=require('../service/desktop_control');
test('desktop input requires both platform leases and stale control quarantines before new work',async t=>{
 let now=0;const store=new Store(':memory:',{now:()=>now,leaseMs:1000});t.after(()=>store.close());
 for(const id of ['web:xhs:default','web:douyin:default'])store.register({id,kind:'web'});
 const leases=store.devices().map(d=>store.externalLease(d.id,'external:pipeline:console'));const chunks=[];
 const tcp=net.createServer(socket=>socket.on('data',b=>chunks.push(b.toString())));await new Promise(r=>tcp.listen(0,'127.0.0.1',r));t.after(()=>tcp.close());
 const token='fixture'.repeat(8),control=new DesktopControl(store,{token,port:tcp.address().port}),server=http.createServer();control.attach(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await control.close();server.close();});
 assert.throws(()=>control.assert([leases[0]]),/ALL_WEB_LEASES_REQUIRED/);
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/v1/desktop/socket',['binary'],{headers:{Authorization:'Bearer '+token,'X-Crawler-Leases':JSON.stringify(leases)}});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});t.after(()=>ws.terminate());
 ws.send(Buffer.from('input'));for(let n=0;n<30&&!chunks.length;n++)await new Promise(r=>setTimeout(r,10));assert.deepEqual(chunks,['input']);
 now=1001;await new Promise(r=>ws.once('close',r));assert.ok(store.devices().every(d=>d.quarantined));assert.throws(()=>store.externalLease('web:xhs:default','external:pipeline:new'),{code:'DEVICE_UNAVAILABLE'});
});
test('HTTP lease release retires and drains an active RFB tunnel before releasing ownership',async t=>{
 const {createServer}=require('../service/server');const store=new Store(':memory:');t.after(()=>store.close());
 for(const id of ['web:xhs:default','web:douyin:default'])store.register({id,kind:'web'});
 const leases=store.devices().map(d=>store.externalLease(d.id,'external:pipeline:console'));const token='fixture'.repeat(8);
 const tcp=net.createServer(socket=>socket.on('error',()=>{}));await new Promise(r=>tcp.listen(0,'127.0.0.1',r));t.after(()=>tcp.close());
 const server=createServer({store,token}),control=new DesktopControl(store,{token,port:tcp.address().port});control.attach(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await control.close();server.closeAllConnections();await new Promise(r=>server.close(r));});
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/v1/desktop/socket',['binary'],{headers:{Authorization:'Bearer '+token,'X-Crawler-Leases':JSON.stringify(leases)}});await new Promise((r,j)=>{ws.once('open',r);ws.once('error',j);});t.after(()=>ws.terminate());
 const active=control.active;assert.ok(active);
 const release=store.releaseExternal.bind(store);store.releaseExternal=lease=>{assert.equal(control.active,null);assert.ok(active.stopping);assert.ok(active.tcp.destroyed);assert.equal(active.ws.readyState,WebSocket.CLOSED);return release(lease);};
 const response=await fetch('http://127.0.0.1:'+server.address().port+'/v1/device-leases/release',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({lease:leases[0]})});assert.equal(response.status,200);await response.json();
 await new Promise(r=>setTimeout(r,150));assert.ok(store.devices().every(d=>!d.quarantined));assert.throws(()=>control.assert(leases),/CONTROL_LEASE_RELEASED/);
 const replacement=store.externalLease(leases[0].device_id,'external:pipeline:replacement');assert.doesNotThrow(()=>control.assert([replacement,leases[1]]));
});
