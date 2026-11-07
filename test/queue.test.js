'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../service/store');
const {parallelism,normalize}=require('../service/contract');
function input(extra={}){return {schema_version:'crawler.request.v1',idempotency_key:'request',platform:'xiaohongshu',operation:'post.detail',effort:'full',targets:[{post_id:'n1'},{post_id:'n2'}],...extra};}
function phone(s,n=1,platform='xiaohongshu'){s.register({id:'phone'+n,serial:'SERIAL'+n,kind:'android',capabilities:[{platform,operation:'post.detail'}]});}
function setup(t,options={}){const s=new Store(':memory:',options);t.after(()=>s.close());return s;}
function done(s,c,key='note'){s.commit(c,{items:[{key,value:{observed_at:'2026-11-07T00:00:00Z',data:'original'}}],checkpoint:{last:key},done:true});}

test('effort uses compatible resources, rounds half up and permits singleton auto',()=>{
  for(const [n,full,half,auto,busy] of [[0,0,0,0,0],[1,1,1,1,1],[2,2,1,1,1],[3,3,2,2,1],[5,5,3,4,3]]){
    assert.equal(parallelism('full',n),full);assert.equal(parallelism('half',n),half);assert.equal(parallelism('auto',n),auto);assert.equal(parallelism('auto',n,true),busy);
  }
});
test('contract rejects unsupported operations, invalid target, unbounded limits, bad timestamps',()=>{
  for(const patch of [{operation:'arbitrary'}, {targets:[{uid:'wrong'}]}, {limits:{max_pages:0}}, {effort:'all'},
    {operation:'profile.posts',targets:[{user_id:'u'}],params:{published_after:'yesterday'}}, {context:{output_path:'/tmp'}}])assert.throws(()=>normalize(input(patch)));
});
test('idempotent submission is scoped and payload checked',t=>{
  const s=setup(t),r=s.submit(input());assert.equal(s.submit(input()).id,r.id);
  assert.throws(()=>s.submit(input({effort:'half'})),{code:'IDEMPOTENCY_CONFLICT'});
  assert.notEqual(s.submit(input(),'other').id,r.id);
});
test('single paginated target stays one indivisible work unit',t=>{
  const s=setup(t);for(let n=1;n<=3;n++)s.register({id:'phone'+n,serial:'s'+n,kind:'android',capabilities:[{platform:'xiaohongshu',operation:'profile.posts'}]});
  s.submit(input({operation:'profile.posts',targets:[{user_id:'u'}]}));assert.ok(s.claim());assert.equal(s.claim(),null);
});
test('two physical devices parallelize while each remains exclusive',t=>{
  const s=setup(t);phone(s,1);phone(s,2);const r=s.submit(input());const a=s.claim(),b=s.claim();
  assert.notEqual(a.device_id,b.device_id);assert.equal(s.claim(),null);assert.throws(()=>s.externalLease(a.device_id,'manual'),{code:'DEVICE_BUSY'});
  done(s,a);done(s,b);assert.equal(s.request(r.id).state,'succeeded');
});
test('web resources are distinct and only one per platform',t=>{
  const s=setup(t);for(const [name,platform] of [['xhs','xiaohongshu'],['douyin','douyin']])s.register({id:`web:${name}:default`,kind:'web',capabilities:[{platform,operation:'post.detail'}]});
  s.submit(input());s.submit(input({idempotency_key:'douyin',platform:'douyin'}));const a=s.claim(),b=s.claim();assert.notEqual(a.device_id,b.device_id);assert.equal(s.claim(),null);
  assert.throws(()=>s.register({id:'web:xhs:second',kind:'web'}),{code:'INVALID_DEVICE'});
});
test('busy healthy peer receives failed device unfinished unit after its own work',t=>{
  const s=setup(t);phone(s,1);phone(s,2);const r=s.submit(input());const a=s.claim(),b=s.claim();
  s.commit(a,{items:[{key:'partial',value:{body:'kept'}}],checkpoint:{cursor:'opaque',device_id:a.device_id}});
  s.fail(a,{code:'LOGIN_REQUIRED',scope:'platform'});assert.equal(s.claim(),null);assert.equal(s.request(r.id).state,'running');
  done(s,b);const takeover=s.claim();assert.equal(takeover.device_id,b.device_id);assert.equal(takeover.unit_id,a.unit_id);assert.equal(takeover.checkpoint.cursor,'opaque');
  done(s,takeover,'resumed');assert.equal(s.request(r.id).state,'succeeded');assert.equal(s.results(r.id).length,3);
});
test('all devices fail with partial evidence retained and explicit retry can resume',t=>{
  const s=setup(t);phone(s);const r=s.submit(input());const a=s.claim();s.commit(a,{items:[{key:'partial',value:{body:'kept'}}],checkpoint:{page:1}});
  s.fail(a,{code:'DEVICE_DISCONNECTED',scope:'device'});assert.equal(s.claim(),null);assert.equal(s.request(r.id).state,'partial');
  s.recoverDevice(a.device_id,{stopped:true});s.transition(r.id,'retry');const next=s.claim();assert.equal(next.checkpoint.page,1);assert.equal(s.results(r.id).length,1);
});
test('device errors do not pause unrelated platforms or infer shared accounts',t=>{
  const s=setup(t);phone(s,1);phone(s,2);s.register({id:'phone3',serial:'SERIAL3',kind:'android',capabilities:[{platform:'douyin',operation:'post.detail'},{platform:'xiaohongshu',operation:'post.detail'}]});
  const x=s.submit(input({routing:{device_ids:['phone3']}}));s.fail(s.claim(),{code:'LOGIN_REQUIRED',scope:'platform'});
  s.submit(input({idempotency_key:'d',platform:'douyin'}));assert.equal(s.claim().payload.platform,'douyin');assert.ok(s.devices().find(d=>d.id==='phone1').health==='ready');
});
test('same-clock claim loop round-robins requests rather than full monopolizing',t=>{
  const s=setup(t,{now:()=>1});for(let i=1;i<=3;i++)phone(s,i);
  const a=s.submit(input()),b=s.submit(input({idempotency_key:'b'}));assert.equal(s.claim().request_id,a.id);assert.equal(s.claim().request_id,b.id);
});
test('external work occupies exact physical device, others remain schedulable',t=>{
  const s=setup(t);phone(s,1);phone(s,2);const l=s.externalLease('phone1','parse-links');s.submit(input());assert.equal(s.claim().device_id,'phone2');assert.equal(s.claim(),null);s.releaseExternal(l);assert.equal(s.claim().device_id,'phone1');
});
test('expired lease quarantines device and fences stale input/result until supervisor confirms stop',t=>{
  let clock=0;const s=setup(t,{now:()=>clock,leaseMs:30});phone(s);const r=s.submit(input());const a=s.claim();clock=31;s.expire();
  assert.throws(()=>done(s,a),{code:'LEASE_LOST'});assert.throws(()=>s.externalLease('phone1','manual'),{code:'DEVICE_UNAVAILABLE'});
  assert.throws(()=>s.recoverDevice('phone1'),{code:'WORKER_STOP_REQUIRED'});s.recoverDevice('phone1',{stopped:true});const b=s.claim();assert.ok(b.lease.generation>a.lease.generation);assert.equal(s.results(r.id).length,0);
});
test('registering an existing device cannot clear quarantine or platform fault',t=>{
  let clock=0;const s=setup(t,{now:()=>clock,leaseMs:30});phone(s);s.externalLease('phone1','other');clock=31;s.expire();phone(s);assert.equal(s.devices()[0].quarantined,1);
});
test('checkpoint and results commit atomically and retries preserve first observation',t=>{
  const s=setup(t);phone(s);const r=s.submit(input());const a=s.claim();
  s.commit(a,{items:[{key:'n',value:{observed_at:'old'}}],checkpoint:{page:1}});
  s.commit(a,{items:[{key:'n',value:{observed_at:'new'}}],checkpoint:{page:2}});
  assert.equal(s.results(r.id)[0].payload.observed_at,'old');assert.equal(s.request(r.id).units[0].checkpoint.page,2);
  assert.throws(()=>s.commit(a,{items:[{key:'ok',value:{}},{key:'',value:{}}],checkpoint:{page:3}}));assert.equal(s.results(r.id).length,1);assert.equal(s.request(r.id).units[0].checkpoint.page,2);
});
test('pause and cancel retain lease until stopped acknowledgement, late result cannot revive',t=>{
  const s=setup(t);phone(s);const r=s.submit(input());const a=s.claim();s.transition(r.id,'pause');assert.equal(s.request(r.id).state,'pausing');
  assert.throws(()=>s.externalLease(a.device_id,'manual'),{code:'DEVICE_BUSY'});s.stopped(a);assert.equal(s.request(r.id).state,'paused');assert.equal(s.claim(),null);
  s.transition(r.id,'resume');const b=s.claim();s.transition(r.id,'cancel');s.stopped(b);assert.equal(s.request(r.id).state,'cancelled');assert.throws(()=>done(s,b),{code:'LEASE_LOST'});
});
test('queue deadline terminates unavailable work without an eternal pending request',t=>{
  let clock=0;const s=setup(t,{now:()=>clock});const r=s.submit(input({limits:{queue_timeout_seconds:1}}));assert.equal(s.claim(),null);assert.equal(s.request(r.id).state,'waiting_resources');clock=1001;s.claim();assert.equal(s.request(r.id).state,'failed');
});
test('reopen durable store preserves accepted request, submitted evidence, lease and checkpoint',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crawler-store-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'queue.db');
  let s=new Store(file);phone(s);const r=s.submit(input()),a=s.claim();s.commit(a,{items:[{key:'one',value:{body:'kept'}}],checkpoint:{page:3}});s.close();
  s=new Store(file);t.after(()=>s.close());assert.equal(s.submit(input()).id,r.id);assert.equal(s.request(r.id).units[0].checkpoint.page,3);assert.equal(s.results(r.id).length,1);assert.equal(s.claim(),null);
});
test('two service handles cannot acquire same device',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crawler-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'queue.db');
  const a=new Store(file),b=new Store(file);t.after(()=>{a.close();b.close();});phone(a);a.submit(input());assert.ok(a.claim());assert.equal(b.claim(),null);
});

test('explicit sorting requires declared matching capability, never silently defaults',t=>{
  const s=setup(t);
  s.register({id:'phone1',serial:'s1',kind:'android',capabilities:[{platform:'xiaohongshu',operation:'search.posts',sorts:['general']}]});
  s.register({id:'phone2',serial:'s2',kind:'android',capabilities:[{platform:'xiaohongshu',operation:'search.posts',sorts:['general','time_descending']}]});
  s.submit(input({operation:'search.posts',targets:[{keyword:'coffee'}],params:{sort:'time_descending'}}));assert.equal(s.claim().device_id,'phone2');
});

test('each phone gets a stable distinct clipboard port for simultaneous Unicode input',t=>{
 const s=setup(t);phone(s,1);phone(s,2);const first=s.devices();assert.notEqual(first[0].clipboard_port,first[1].clipboard_port);phone(s,1);assert.equal(s.devices()[0].clipboard_port,first[0].clipboard_port);
});

test('v1 database gains stable phone ports without deleting device state',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'crawler-upgrade-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'queue.db');
 const Database=require('better-sqlite3'),old=new Database(file);old.exec(`CREATE TABLE devices(id TEXT PRIMARY KEY,kind TEXT NOT NULL,serial TEXT,capabilities TEXT NOT NULL,health TEXT NOT NULL,faults TEXT NOT NULL DEFAULT '{}',generation INTEGER NOT NULL DEFAULT 0,quarantined INTEGER NOT NULL DEFAULT 0);
 INSERT INTO devices(id,kind,serial,capabilities,health,quarantined) VALUES ('phone','android','serial','[]','unavailable',1); PRAGMA user_version=1;`);old.close();
 const s=new Store(file);t.after(()=>s.close());assert.equal(s.devices()[0].health,'unavailable');assert.equal(s.devices()[0].quarantined,1);assert.equal(s.devices()[0].clipboard_port,38617);assert.equal(s.db.pragma('user_version',{simple:true}),3);
});

test('business decisions are checkpoint-bound, idempotent and preserve paused unit state',t=>{
 const s=setup(t);phone(s);const r=s.submit(input({continuation:{mode:'manual'}})),c=s.claim();
 s.commit(c,{checkpoint:{page:1},items:[{key:'n',value:{body:'evidence'}}]});const d=s.requestDecision(c);assert.equal(s.request(r.id).units[0].state,'waiting_decision');
 assert.throws(()=>s.commit(c,{checkpoint:{page:2}}),{code:'BUSINESS_DECISION_REQUIRED'});
 s.transition(r.id,'pause');s.stopped(c);s.decide(r.id,d.id,'continue');assert.equal(s.request(r.id).state,'paused');assert.equal(s.request(r.id).units[0].state,'queued');
 assert.equal(s.decide(r.id,d.id,'continue').action,'continue');assert.throws(()=>s.decide(r.id,d.id,'stop'),{code:'DECISION_CONFLICT'});
});

test('a delayed decision cannot authorize a different checkpoint',t=>{
 const s=setup(t);phone(s);const r=s.submit(input({continuation:{mode:'manual'}})),c=s.claim();
 s.commit(c,{checkpoint:{page:1}});const d=s.requestDecision(c);
 // Model a recovered adapter advancing its durable checkpoint after failure.
 s.db.prepare('UPDATE units SET checkpoint=? WHERE id=?').run(JSON.stringify({page:2}),c.unit_id);
 assert.throws(()=>s.decide(r.id,d.id,'continue'),{code:'DECISION_STALE'});
 assert.equal(s.request(r.id).decisions.length,0);
 assert.equal(s.request(r.id).units[0].state,'waiting_decision');
});
