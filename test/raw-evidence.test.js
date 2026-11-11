'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{createHash}=require('node:crypto');
const {RawEvidenceStore}=require('../service/raw_evidence');
const {persistResult}=require('../service/result_evidence');
const {Store}=require('../service/store');
const Database=require('better-sqlite3');
const obs={platform:'xiaohongshu',kind:'post.detail',subject:{note_id:'note'},observed_at:'2026-10-01T00:00:00+00:00',source:{provider:'crawler_queue',request_id:'request'},outcome:'success'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'raw-evidence-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:new RawEvidenceStore(root)};}
const claim={request_id:'request',target:{post_id:'note'},payload:{platform:'xiaohongshu',operation:'post.detail'}};

test('immutable producer bytes deduplicate while observations retain original clocks',t=>{
 const {root,store}=fixture(t),bytes=Buffer.from('{"z":1e-7,"文":"🍜","a":1.0}');
 const a=store.capture(bytes,obs),b=store.capture(bytes,{...obs,observed_at:'2026-10-02T00:00:00+00:00'});
 assert.equal(a.sha256,b.sha256);assert.notEqual(a.observation_id,b.observation_id);
 assert.deepEqual(store.readBytes(a),bytes);assert.equal(store.observation(a).observed_at,obs.observed_at);
 assert.equal(fs.statSync(store.filename).mode&0o777,0o600);
 assert.deepEqual(store.stats(),{objects:1,observations:2,bytes:bytes.length});
 assert.throws(()=>store.capture({z:1},obs),{code:'RAW_EVIDENCE_BYTES_REQUIRED'});
 const db=new Database(store.filename);assert.throws(()=>db.prepare('UPDATE objects SET content=? WHERE hash=?').run(bytes,a.sha256));db.exec('DROP TRIGGER objects_no_update');db.prepare('UPDATE objects SET bytes=?,content=? WHERE hash=?').run(7,Buffer.from('changed'),a.sha256);db.close();
 assert.throws(()=>store.readJson(a),{code:'RAW_EVIDENCE_HASH_MISMATCH'});
});

test('Python-produced archive fixture has exactly matching body and observation hashes',t=>{
 const {store}=fixture(t),f=require('./fixtures/raw-ref-python-interop.json');
 const ref=store.capture(Buffer.from(f.body_base64,'base64'),f.observation);
 assert.deepEqual(ref,f.raw_ref);assert.deepEqual(store.readJson({...ref,pointer:'/nested/a~1b/0'}),f.selected);
 for(const invalid of ['/nested/a~1b/01','/nested/a~1b/-1','/absent'])assert.throws(()=>store.readJson({...ref,pointer:invalid}),{code:'RAW_REF_POINTER_MISSING'});
 assert.throws(()=>store.readBytes({...ref,sha256:'../../outside'}),{code:'RAW_REF_DIGEST_INVALID'});
});

test('archive symlinks and substituted observation identities fail closed',t=>{
 const {root,store}=fixture(t),ref=store.capture(Buffer.from('{}'),obs),other=store.capture(Buffer.from('{"other":1}'),obs);
 assert.throws(()=>store.readBytes({...ref,observation_id:other.observation_id}),{code:'RAW_REF_OBSERVATION_MISMATCH'});
 const outside=path.join(root,'outside');fs.writeFileSync(outside,'{}');fs.rmSync(store.filename+'-wal',{force:true});fs.symlinkSync(outside,store.filename+'-wal');
 assert.throws(()=>store.readBytes(ref),{code:'RAW_REF_SYMLINK_REJECTED'});
});

test('XHS Web result stores one raw source; normalized metadata and input objects stay intact',t=>{
 const {store}=fixture(t),value={phase:'result',observed_at:obs.observed_at,data:{raw:{feeds:[{id:'note',title:'正文'}]},end_observed:true,stop_reason:'profile_end'}};
 const thin=persistResult(store,claim,value);
 assert.deepEqual(store.readJson(thin.data.raw_ref),value.data.raw);
 assert.equal(thin.data.end_observed,true);assert.equal(thin.phase,value.phase);assert.ok(value.data.raw);assert.equal(thin.data.raw,undefined);
});

test('native result archives response once, points profile at its fragment, and drops duplicated originals',t=>{
 const {store}=fixture(t),profile={id:'user',nickname:'昵称'},response={data:{user:profile}},value={observed_at:obs.observed_at,data:{response,raw:{native_profile:profile,profile_user_id:'user',feeds:[{noteCard:{title:'标题',_native_original:{title:'标题',extra:'large'}}}]},native_evidence:[{operation:'profile.get',observed_at:obs.observed_at}]}};
 const thin=persistResult(store,{...claim,target:{user_id:'user'}},value);
 assert.deepEqual(store.readJson(thin.data.raw.native_profile_ref),profile);
 assert.equal(thin.data.raw.native_profile_ref.sha256,thin.data.response_ref.sha256);
 assert.equal(thin.data.raw.feeds[0].noteCard._native_original,undefined);
 assert.equal(thin.data.response,undefined);assert.deepEqual(store.readJson(thin.data.response_ref),response);
});

test('Douyin raw bodies have a single reference, without duplicate item or body copies',t=>{
 const {store}=fixture(t),body={aweme_detail:{aweme_id:'123',desc:'原文'}},value={observed_at:obs.observed_at,data:{body,items:[body.aweme_detail],cursor:9,records:[{body,endpoint:'aweme_detail',captured_at:1792668608.25,status:200}]}};
 const thin=persistResult(store,{...claim,payload:{platform:'douyin',operation:'post.detail'}},value);
 assert.equal(thin.data.items,undefined);assert.equal(thin.data.body,undefined);assert.equal(thin.data.cursor,9);
 assert.deepEqual(store.readJson(thin.data.records[0].raw_ref),body);assert.equal(store.observation(thin.data.records[0].raw_ref).observed_at,'2026-10-22T11:30:08.250Z');
});

test('durable queue restarts keep checkpoints, first evidence, retry state and raw observation unchanged',t=>{
 const {root,store:raw}=fixture(t),db=path.join(root,'queue.db');let queue=new Store(db,{rawEvidence:raw});
 const input={schema_version:'crawler.request.v1',idempotency_key:'raw-test',platform:'xiaohongshu',operation:'post.detail',targets:[{post_id:'note'}]};
 queue.register({id:'web:xhs:default',kind:'web',capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]});
 const request=queue.submit(input),work=queue.claim(),checkpoint={cursor:'opaque',seen_ids:['note'],binding:'same'};
 const value={phase:'result',observed_at:obs.observed_at,data:{raw:{note:{id:'note',desc:'first'}}}};
 queue.commit(work,{items:[{key:'result',value}],checkpoint});const original=queue.results(request.id)[0];
 queue.commit(work,{items:[{key:'result',value:{...value,observed_at:'2030-01-01T00:00:00Z'}}],checkpoint});
 assert.deepEqual(queue.results(request.id)[0],original);
 queue.fail(work,{code:'READ_FAILED',scope:'item'});assert.equal(queue.request(request.id).state,'partial');queue.close();
 queue=new Store(db,{rawEvidence:raw});t.after(()=>queue.close());
 assert.deepEqual(queue.results(request.id)[0],original);assert.deepEqual(queue.request(request.id).units[0].checkpoint,checkpoint);
 queue.transition(request.id,'retry');const retry=queue.claim();assert.deepEqual(retry.checkpoint,checkpoint);
 queue.commit(retry,{done:true,checkpoint});assert.equal(queue.request(request.id).state,'succeeded');
 const saved=JSON.parse(queue.db.prepare('SELECT payload FROM results').get().payload);assert.equal(saved.data.raw,undefined);
 assert.deepEqual(raw.readJson(saved.data.raw_ref),value.data.raw);
});

test('resolved-link business identity stays explicit while its original response is archived',t=>{
 const {store}=fixture(t),body={resolved_url:'https://www.douyin.com/video/123',post_id:'123'};
 const thin=persistResult(store,{...claim,payload:{platform:'douyin',operation:'link.resolve'}},{data:{body,items:[],records:[{body,endpoint:'aweme_search',captured_at:1792668608,status:200}]}});
 assert.equal(thin.data.resolved_url,body.resolved_url);assert.equal(thin.data.post_id,'123');assert.equal(thin.data.body,undefined);
 assert.deepEqual(store.readJson(thin.data.records[0].raw_ref),body);
});

test('archive failures remain item errors and never acquire device-fault semantics',t=>{
 const {root,store}=fixture(t);fs.mkdirSync(store.filename);
 assert.throws(()=>store.capture(Buffer.from('{}'),obs),error=>error.code==='RAW_EVIDENCE_UNAVAILABLE'&&error.scope==='item');
});

test('two-round discovery returns original profile and card refs without a second collection or raw copy',async t=>{
 const {root,store:raw}=fixture(t),queue=new Store(':memory:',{rawEvidence:raw}),{DiscoverySessions}=require('../service/discovery_sessions');
 const uid='a'.repeat(24),nid='b'.repeat(24),profile={posted:1,basicInfo:{nickname:'账号'},result:{success:true,code:0}};
 queue.register({id:'web:xhs:default',kind:'web',capabilities:['profile.posts','post.detail'].map(operation=>({platform:'xiaohongshu',operation}))});
 let reads=0;
 const adapter={async execute(ctx){reads++;ctx.commit({items:[{value:{phase:'result',observed_at:obs.observed_at,data:{raw:{profile,profile_user_id:uid,active:{index:0,query:'note'},feeds:[{id:nid,noteCard:{displayTitle:'原标题',interactInfo:{sticky:false,likedCount:0}}}],platform_only:'kept once'},end_observed:true,profile_end_observation:{schema:'xhs_profile_end_observation_v1',terminal_decision:'unverified',dom_snapshot:{tree:{tag:'div'},truncated:false}}}}}]});},async close(){}};
 const sessions=new DiscoverySessions({store:queue,adapters:new Map([['web:xhs:default',adapter]])});
 t.after(async()=>{await sessions.close();queue.close();});
 const result=await sessions.open({schema_version:'crawler.discovery.v1',platform:'xiaohongshu',user_id:uid,mode:'count',count:1,profile_end_policy:'observed_terminal_v1'});
 assert.deepEqual(raw.readJson(result.profile.profile_ref),profile);assert.equal(result.profile.observed_at,obs.observed_at);
 assert.equal(result.profile.profile,undefined);assert.equal(result.raw_refs.length,1);
 assert.equal(result.profile_end_observation.dom_snapshot,undefined);assert.equal(raw.readJson(result.profile_end_observation.raw_ref).dom_snapshot.tree.tag,'div');
 assert.equal(raw.readJson(result.cards[0].raw_ref).id,nid);assert.equal(result.cards[0].like_count,0);
 assert.equal(result.cards[0].raw_ref.sha256,result.profile.profile_ref.sha256);
 assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM results').get().n,0,'external discovery must not create a nested queue job');
 assert.equal((await sessions.complete(result.session_id,{selected_ids:[]})).released,true);assert.equal(reads,1);
 assert.equal(raw.readJson(result.raw_refs[0]).platform_only,'kept once');
});

test('DOM observation preserves its own original and only a terminal-evidence header travels downstream',t=>{
 const {store}=fixture(t),observation={schema:'xhs_profile_end_observation_v1',policy:'observed_terminal_v1',terminal_decision:'observed',terminal_evidence:{kind:'profile_reported_total_v1',reported_total:19},dom_snapshot:{tree:{text:'observed tail'},truncated:false}};
 const result=persistResult(store,claim,{observed_at:obs.observed_at,data:{raw:{feeds:[]},profile_end_observation:observation}});
 const header=result.data.profile_end_observation;
 assert.equal(header.dom_snapshot,undefined);assert.equal(header.terminal_decision,'observed');assert.deepEqual(header.terminal_evidence,observation.terminal_evidence);assert.equal(header.truncated,false);
 assert.deepEqual(store.readJson(header.raw_ref),observation);assert.equal(store.observation(header.raw_ref).kind,'profile.end.observation');
 assert.notEqual(header.raw_ref.sha256,result.data.raw_ref.sha256);
});


test('failed observation insertion rolls back the body and never publishes a partial reference',t=>{
 const {store}=fixture(t),db=store.open(true);db.exec("CREATE TRIGGER reject_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'fixture'); END");db.close();
 assert.throws(()=>store.capture(Buffer.from('{"atomic":true}'),obs),{code:'RAW_EVIDENCE_UNAVAILABLE'});
 assert.deepEqual(store.stats(),{objects:0,observations:0,bytes:0});
});

test('archive I/O cannot commit evidence after its original execution lease expires',t=>{
 const {store:raw}=fixture(t);let clock=1000;
 const queue=new Store(':memory:',{now:()=>clock,leaseMs:10,rawEvidence:{capture(...args){const ref=raw.capture(...args);clock+=11;return ref;}}});t.after(()=>queue.close());
 queue.register({id:'web:xhs:default',kind:'web',capabilities:[{platform:'xiaohongshu',operation:'post.detail'}]});
 const request=queue.submit({schema_version:'crawler.request.v1',idempotency_key:'fenced-raw',platform:'xiaohongshu',operation:'post.detail',targets:[{post_id:'note'}]}),work=queue.claim();
 assert.throws(()=>queue.commit(work,{items:[{key:'result',value:{observed_at:obs.observed_at,data:{raw:{note:{id:'note'}}}}}],checkpoint:{cursor:'must-not-persist'}}),{code:'LEASE_LOST'});
 assert.equal(queue.db.prepare('SELECT COUNT(*) n FROM results').get().n,0);assert.equal(queue.db.prepare('SELECT checkpoint FROM units WHERE request_id=?').get(request.id).checkpoint,null);
});
