'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../service/store'),{Scheduler}=require('../service/scheduler');
const request=(key,platform='xiaohongshu',extra={})=>({schema_version:'crawler.request.v1',idempotency_key:key,platform,operation:'post.detail',effort:'full',targets:[{post_id:key}],...extra});
const register=(s,id,platform='xiaohongshu')=>s.register({id,kind:id.startsWith('web:')?'web':'android',serial:id.startsWith('web:')?null:id,capabilities:[{platform,operation:'post.detail'}]});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<200;i++){if(fn())return;await sleep(5);}assert.fail('condition did not become true');}
function setup(t,options={}){const s=new Store(':memory:',options);t.after(()=>s.close());return s;}
test('default empty adapter registry never consumes or faults persisted devices',async t=>{
 const s=setup(t);register(s,'phone');const r=s.submit(request('one'));const scheduler=new Scheduler(s,new Map(),{pollMs:2});scheduler.start();await sleep(12);await scheduler.close();
 assert.equal(s.request(r.id).state,'queued');assert.equal(s.devices()[0].health,'ready');assert.equal(s.db.prepare('SELECT count(*) n FROM attempts').get().n,0);
});
test('continuous scheduling runs xhs web, phone and douyin web independently and exclusively',async t=>{
 const s=setup(t),ids=['web:xhs:default','phone','web:douyin:default'];ids.forEach((id,i)=>register(s,id,i===2?'douyin':'xiaohongshu'));
 const busy=new Set(),seen=new Set();let peak=0;
 const adapters=new Map(ids.map(id=>[id,{version:'1',execute:async({claim,input,commit})=>{assert.ok(!busy.has(id));busy.add(id);seen.add(id);peak=Math.max(peak,busy.size);try{await input(()=>sleep(15));commit({items:[{key:claim.target.post_id,value:{body:id}}]});}finally{busy.delete(id);}}}]));
 const scheduler=new Scheduler(s,adapters,{pollMs:2,heartbeatMs:3});const rs=ids.map((id,i)=>s.submit(request('n'+i,i===2?'douyin':'xiaohongshu',{routing:{device_ids:[id]}})));
 scheduler.start();await until(()=>rs.every(r=>s.request(r.id).state==='succeeded'));
 const late=s.submit(request('late','douyin'));await until(()=>s.request(late.id).state==='succeeded');await scheduler.close();assert.equal(peak,3);assert.equal(seen.size,3);
});
test('external lock blocks scheduling and heartbeat/release checks owner and fencing',async t=>{
 let now=100;const s=setup(t,{now:()=>now,leaseMs:30});register(s,'phone');const lease=s.externalLease('phone','gadget');
 assert.equal(s.assertLease(lease,{owner:'gadget',externalOnly:true}).owner,'gadget');assert.throws(()=>s.assertLease(lease,{owner:'other'}),{code:'LEASE_OWNER_MISMATCH'});
 const r=s.submit(request('locked'));assert.equal(s.claim(),null);now+=10;assert.equal(s.heartbeat(lease).expires,140);s.releaseExternal(lease);
 const c=s.claim();assert.equal(c.request_id,r.id);assert.throws(()=>s.heartbeat(lease),{code:'LEASE_LOST'});assert.throws(()=>s.assertLease(c.lease,{externalOnly:true}),{code:'WORKER_STOP_REQUIRED'});
});
test('presence changes preserve faults quarantine and active leases',t=>{
 const s=setup(t);register(s,'phone');const lease=s.externalLease('phone','manual');s.setPresence('phone',false);assert.equal(s.devices()[0].health,'disconnected');assert.equal(s.devices()[0].owner,'manual');
 s.quarantine('phone');s.setPresence('phone',true);assert.equal(s.devices()[0].quarantined,1);s.releaseExternal(lease);assert.equal(s.devices()[0].quarantined,1);
 s.db.prepare("UPDATE devices SET health='unavailable',faults=? WHERE id='phone'").run(JSON.stringify({xiaohongshu:'LOGIN_REQUIRED'}));s.setPresence('phone',true);assert.equal(s.devices()[0].health,'unavailable');assert.equal(s.devices()[0].faults.xiaohongshu,'LOGIN_REQUIRED');
});
test('persistent dispatch fairness survives restart and expired lease stays isolated',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));let now=1;const file=path.join(dir,'queue.db');let s=new Store(file,{now:()=>now,leaseMs:10});register(s,'phone');
 const first=s.submit(request('a','xiaohongshu',{targets:[{post_id:'a'},{post_id:'b'}]}));const second=s.submit(request('c'));const a=s.claim();assert.equal(a.request_id,first.id);s.commit(a,{done:true});s.close();
 s=new Store(file,{now:()=>now,leaseMs:10});const c=s.claim();assert.equal(c.request_id,second.id);s.close();now=20;s=new Store(file,{now:()=>now,leaseMs:10});s.expire();assert.equal(s.devices()[0].quarantined,1);assert.equal(s.claim(),null);assert.throws(()=>s.commit(c,{done:true}),{code:'LEASE_LOST'});s.recoverDevice('phone',{stopped:true});assert.equal(s.claim().request_id,first.id);s.close();
});
test('device failure preserves checkpoint and healthy fake consumer takes over',async t=>{
 const s=setup(t);register(s,'a');register(s,'b');let replay;
 const r=s.submit(request('failover'));const scheduler=new Scheduler(s,new Map([
 ['a',{version:'1',execute:async({commit,resume,claim})=>{commit({items:[{key:'kept',value:{body:'first'}}],checkpoint:{binding:resume.binding,device_id:claim.device_id,adapter_version:'1',cursor:'old',seen_ids:['kept']}});throw Object.assign(Error('off'),{code:'DEVICE_DISCONNECTED',scope:'device'});}}],
 ['b',{version:'1',execute:async({resume,commit})=>{replay=resume;commit({items:[{key:'kept',value:{body:'replacement'}},{key:'new',value:{body:'second'}}]});}}]
 ]),{pollMs:2});scheduler.start();await until(()=>s.request(r.id).state==='succeeded');await scheduler.close();assert.equal(replay.mode,'replay_deduplicate');assert.equal(replay.cursor,null);assert.equal(s.results(r.id)[0].payload.body,'first');
});
test('uncooperative input is quarantined on close, stale callbacks cannot write or input',async t=>{
 const s=setup(t);register(s,'phone');const r=s.submit(request('hang'));let ctx,resolve;
 const scheduler=new Scheduler(s,new Map([['phone',{version:'1',execute:context=>{ctx=context;return new Promise(r=>{resolve=r;});}}]]),{pollMs:2,heartbeatMs:2,stopTimeoutMs:8});scheduler.start();await until(()=>!!ctx);await scheduler.close();
 assert.equal(s.devices()[0].quarantined,1);assert.ok(s.devices()[0].owner);let touched=false;await assert.rejects(ctx.input(()=>{touched=true;}));assert.equal(touched,false);assert.throws(()=>ctx.commit({done:true}));assert.equal(s.request(r.id).state,'running');resolve();await sleep(1);
});
test('graceful shutdown yields drained work without faulting device and resumes later',async t=>{
 const s=setup(t);register(s,'phone');const r=s.submit(request('shutdown'));let ready=false;
 const scheduler=new Scheduler(s,new Map([['phone',{version:'1',execute:async({signal})=>{ready=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}}]]),{pollMs:2});scheduler.start();await until(()=>ready);await scheduler.close();assert.equal(s.request(r.id).state,'queued');assert.equal(s.devices()[0].health,'ready');assert.equal(s.devices()[0].owner,null);
});
test('execution deadline aborts and drains fake adapter before terminal release',async t=>{
 let now=0;const s=setup(t,{now:()=>now});register(s,'phone');const r=s.submit(request('deadline','xiaohongshu',{limits:{execution_timeout_seconds:1}}));let ready=false,stopped=false;
 const scheduler=new Scheduler(s,new Map([['phone',{version:'1',execute:async({signal})=>{ready=true;await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{stopped=true;reject(signal.reason);},{once:true}));}}]]),{pollMs:2,heartbeatMs:2});scheduler.start();await until(()=>ready);now=1000;await until(()=>s.request(r.id).state==='failed');await scheduler.close();assert.ok(stopped);assert.equal(s.request(r.id).units[0].error.code,'EXECUTION_DEADLINE');assert.equal(s.devices()[0].owner,null);
});
test('active input command blocks every ordinary release and recovery path',t=>{
 const s=setup(t);register(s,'phone');s.db.exec('CREATE TABLE device_commands(device_id TEXT PRIMARY KEY)');const external=s.externalLease('phone','gadget');s.db.prepare('INSERT INTO device_commands VALUES (?)').run('phone');assert.throws(()=>s.releaseExternal(external),{code:'DEVICE_COMMAND_ACTIVE'});s.db.prepare('DELETE FROM device_commands').run();s.releaseExternal(external);
 s.db.prepare('INSERT INTO device_commands VALUES (?)').run('phone');assert.throws(()=>s.externalLease('phone','other'),{code:'DEVICE_COMMAND_ACTIVE'});assert.throws(()=>s.recoverDevice('phone',{stopped:true}),{code:'DEVICE_COMMAND_ACTIVE'});s.db.prepare('DELETE FROM device_commands').run();
 const r=s.submit(request('command'));const c=s.claim();s.db.prepare('INSERT INTO device_commands VALUES (?)').run('phone');assert.throws(()=>s.commit(c,{items:[{key:'n',value:{body:'not committed'}}],done:true}),{code:'DEVICE_COMMAND_ACTIVE'});assert.equal(s.results(r.id).length,0);assert.equal(s.request(r.id).state,'running');assert.equal(s.devices()[0].owner,r.id);
});
test('worker renews lease throughout a long fake operation',async t=>{
 const s=setup(t,{leaseMs:40});register(s,'phone');const r=s.submit(request('heartbeat'));
 const scheduler=new Scheduler(s,new Map([['phone',{version:'1',execute:async({input})=>{await sleep(75);await input(()=>{});}}]]),{pollMs:2,heartbeatMs:5});scheduler.start();await until(()=>s.request(r.id).state==='succeeded');await scheduler.close();assert.equal(s.devices()[0].quarantined,0);
});

test('dispatch prefers compatible idle phones independent of IDs and respects routing and availability',t=>{
 for(const scenario of ['both','busy','web-only','bound-web','unsupported','faulted']){
  const s=setup(t);register(s,'web:xhs:default');register(s,'z-phone',scenario==='unsupported'?'douyin':'xiaohongshu');
  if(scenario==='busy')s.externalLease('z-phone','operator');
  if(scenario==='faulted')s.db.prepare('UPDATE devices SET faults=? WHERE id=?').run(JSON.stringify({xiaohongshu:'LOGIN_REQUIRED'}),'z-phone');
  const routing=scenario==='web-only'?{kinds:['web']}:scenario==='bound-web'?{device_ids:['web:xhs:default']}:{kinds:['web','android']};
  s.submit(request(scenario,'xiaohongshu',{routing}));
  assert.equal(s.claim().device_id,scenario==='both'?'z-phone':'web:xhs:default',scenario);
 }
});
